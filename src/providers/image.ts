import { rm } from "node:fs/promises";
import { join } from "node:path";
import { dataDir, loadSettings, type Settings } from "../config";
import { ensureDir, exists } from "../util/fs";
import { runProcess } from "../util/ffmpeg";
import { fetchRemoteFile, scpToRemote, shellQuote, sshReachable, sshRun, withRemoteWorkdir } from "../util/ssh";

export type ImageBackend = "icompify" | "openrouter" | "openai" | "local";

export type ImageResult = {
  bytes: Uint8Array;
  mimeType: string;
  model: string;
  backend: ImageBackend;
  /** 本地出图耗时（秒），只有 local 后端有 */
  seconds?: number;
  width?: number;
  height?: number;
};

export type ImageProgress = (percent: number, label: string) => void;

export type GenerateImageOptions = {
  prompt: string;
  size?: string;
  ratio?: string;
  /** 参考图（绝对路径）；只有本地后端真正支持多张条件图 */
  references?: string[];
  signal?: AbortSignal;
  onProgress?: ImageProgress;
};

const edges: Record<string, number> = { "1K": 1024, "2K": 2048, "4K": 4096 };

function resolveSize(size: string | undefined, ratio: string) {
  const raw = (size ?? "").trim();
  if (/^\d+x\d+$/i.test(raw)) return raw;
  const edge = edges[raw.toUpperCase()] ?? 2048;
  const [width, height] = (ratio || "1:1").split(":").map(Number);
  if (!width || !height) return `${edge}x${edge}`;
  const scale = edge / Math.max(width, height);
  const w = Math.max(64, Math.round((width * scale) / 16) * 16);
  const h = Math.max(64, Math.round((height * scale) / 16) * 16);
  return `${w}x${h}`;
}

/** Qwen-Image 的 VAE 要求边长是 32 的倍数；这里按短边 + 画幅比例推算。 */
function resolveLocalSize(shortEdge: number, ratio: string) {
  // 用 floor 对齐 1344x768 这类 Qwen 官方尺寸；round 会把 16:9 推到 1376。
  const snap = (value: number) => Math.max(256, Math.floor(value / 32) * 32);
  const [width, height] = (ratio || "16:9").split(":").map(Number);
  if (!width || !height) return { width: snap(shortEdge), height: snap(shortEdge) };
  const scale = shortEdge / Math.min(width, height);
  return { width: snap(width * scale), height: snap(height * scale) };
}

async function pythonReady(pythonBin: string) {
  const value = pythonBin.trim();
  if (!value) return false;
  return value.includes("/") ? exists(value) : Boolean(Bun.which(value));
}

async function scriptReady(script: string) {
  const value = script.trim();
  return Boolean(value) && exists(value);
}

/**
 * 决定本地图片后端用哪种连法。
 * auto：本机同时有脚本与 Python 就直连，否则配了 host 就走 SSH。
 * direct / ssh：显式指定，缺配置时返回 undefined 交给调用方报具体错误。
 */
export async function localImageMode(settings: Settings): Promise<"direct" | "ssh" | undefined> {
  const local = settings.image.local;
  const sshReady = Boolean(local.host.trim() && local.script.trim() && local.pythonBin.trim());
  if (local.mode === "ssh") return sshReady ? "ssh" : undefined;
  if (local.mode === "direct") return local.script.trim() && local.pythonBin.trim() ? "direct" : undefined;
  if ((await scriptReady(local.script)) && (await pythonReady(local.pythonBin))) return "direct";
  return sshReady ? "ssh" : undefined;
}

/** 本机脚本 / Python 是否就绪，给自检复用。 */
export async function localImageFiles(settings: Settings) {
  return {
    script: await scriptReady(settings.image.local.script),
    python: await pythonReady(settings.image.local.pythonBin),
  };
}

/**
 * 环境变量只覆盖「连哪台机器 / 用哪种连法」，用于测试脚本；正常情况下走 data/settings.json。
 * 会直接修改传入的 settings（调用方拿到的是 loadSettings 的缓存对象）。
 */
export function applyLocalImageEnv(settings: Settings) {
  const local = settings.image.local;
  local.host = process.env.IMAGEGEN_LOCAL_HOST?.trim() || local.host;
  local.sshBin = process.env.IMAGEGEN_SSH_BIN?.trim() || local.sshBin;
  local.scpBin = process.env.IMAGEGEN_SCP_BIN?.trim() || local.scpBin;
  local.script = process.env.IMAGEGEN_LOCAL_SCRIPT?.trim() || local.script;
  local.pythonBin = process.env.IMAGEGEN_LOCAL_PYTHON?.trim() || local.pythonBin;
  local.workdir = process.env.IMAGEGEN_LOCAL_WORKDIR?.trim() || local.workdir;
  const mode = process.env.IMAGEGEN_LOCAL_MODE?.trim();
  if (mode === "auto" || mode === "direct" || mode === "ssh") local.mode = mode;
}

/** local 后端 SSH 模式是否配置齐全（host + script + pythonBin）。 */
export function localImageConfigured(settings: Settings) {
  const local = settings.image.local;
  return Boolean(local.host.trim() && local.script.trim() && local.pythonBin.trim());
}

/** 远端主机是否可免密登录（会真的发一条 ssh true）。 */
export async function localImageReachable(settings: Settings, signal?: AbortSignal) {
  const local = settings.image.local;
  if (!localImageConfigured(settings)) return false;
  return sshReachable(local.sshBin || "ssh", local.host.trim(), signal);
}

/**
 * 决定本次走哪个后端。
 * auto = 本机能直连就直连，否则 SSH 可达就用远端，都不可达回退远程图片模型。
 * local = 只用本地后端（失败直接报错，方便暴露问题）。
 */
export async function resolveImageBackend(
  options: { signal?: AbortSignal; onProgress?: ImageProgress } = {},
): Promise<ImageBackend | undefined> {
  const settings = await loadSettings();
  const api = settings.image.api;
  const hasApi = remoteImageReady(settings);
  const remote: ImageBackend = remoteImageBackend(settings);
  if (api === "local") return "local";
  if (api === "openai" || api === "openrouter" || api === "icompify") return hasApi ? remote : undefined;

  const mode = await localImageMode(settings);
  if (mode === "direct") return "local";
  if (mode === "ssh") {
    options.onProgress?.(3, "探测本地主机是否可达");
    if (await localImageReachable(settings, options.signal)) return "local";
    if (hasApi) {
      options.onProgress?.(5, "本地后端不可达，回退远程图片模型");
      return remote;
    }
    return "local"; // 没配 API 时仍然尝试本地后端，让报错更具体
  }
  return hasApi ? remote : undefined;
}

type RemoteBackend = "icompify" | "openrouter" | "openai";

/** image.apiKey 留空时复用 video.apiKey：图片与视频本来就在同一个 icompify 账号下。 */
export function imageApiKey(settings: Settings) {
  return settings.image.apiKey.trim() || settings.video.apiKey.trim();
}

/**
 * 远程后端只由 api 或 baseUrl 推断，不单独存字段：
 * 已经填过 OpenRouter 地址的老配置仍然按 openrouter 走。
 */
export function remoteImageBackend(settings: Settings): RemoteBackend {
  const api = settings.image.api;
  if (api === "icompify" || api === "openai" || api === "openrouter") return api;
  if (/icompify\.com/i.test(settings.image.baseUrl)) return "icompify";
  if (/openrouter\.ai/i.test(settings.image.baseUrl)) return "openrouter";
  return "openai";
}

/** 远程图片后端是否算「配置好了」；icompify 是计费云，没 Key 就不算可用。 */
export function remoteImageReady(settings: Settings) {
  if (!settings.image.baseUrl.trim() || !settings.image.model.trim()) return false;
  return remoteImageBackend(settings) === "icompify" ? Boolean(imageApiKey(settings)) : true;
}

function dataUriBytes(url: string) {
  const match = /^data:([^;,]+)?(;base64)?,/i.exec(url);
  if (!match) return undefined;
  const payload = url.slice(match[0].length);
  const bytes = match[2]
    ? new Uint8Array(Buffer.from(payload, "base64"))
    : new Uint8Array(Buffer.from(decodeURIComponent(payload), "binary"));
  return { bytes, mimeType: match[1] || "image/png" };
}

function delay(signal: AbortSignal, ms: number) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("已取消"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 网关自己活着、上游 predictor 在重启时返回这三个码；这类失败请求不计费，重试是安全的。 */
const retryableImageStatus = new Set([502, 503, 504]);
const imageAttempts = 3;

/**
 * icompify 出图走的是 SGLang 的 OpenAI 兼容 chat 多模态接口：
 * POST /v1/chat/completions，图片以 data URI 出现在 choices[0].message.content[] 里。
 * 该网关没有 /v1/images/generations（实测 404），所以不能复用下面的 openai 分支。
 * 上游 predictor 会不定期滚动重启并返回 502「dial tcp ... connection refused」，
 * 因此这里对 502/503/504 与网络错误做 3 次退避重试（实测几秒后就恢复）。
 * ACT: 只取第一张图；n>1 与条件图（输入 image_url）尚未验证，不要让调用方假设支持。
 */
async function generateViaIcompify(options: GenerateImageOptions, settings: Settings): Promise<ImageResult> {
  const baseUrl = settings.image.baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  const model = settings.image.model.trim();
  const apiKey = imageApiKey(settings);
  if (!apiKey) throw new Error("尚未配置 icompify API Key：填 image.apiKey，或让 image.apiKey 留空复用 video.apiKey");
  const size = resolveSize(options.size ?? settings.image.size, options.ratio ?? "16:9");
  const timeout = AbortSignal.timeout(300_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const started = Date.now();
  let lastError = "未知错误";
  for (let attempt = 1; attempt <= imageAttempts; attempt += 1) {
    options.onProgress?.(20, attempt === 1 ? `请求 ${model || "icompify"} 出图（${size}）` : `重试 ${attempt}/${imageAttempts}：${model || "icompify"} 出图`);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: options.prompt }], size, n: 1 }),
        signal,
      });
    } catch (error) {
      lastError = (error as Error).message;
      if (signal.aborted || attempt === imageAttempts) break;
      await delay(signal, attempt * 2_000);
      continue;
    }
    const text = await response.text();
    if (response.ok) return readIcompifyImage(text, model, started);
    lastError = `HTTP ${response.status}：${text.slice(0, 400)}`;
    if (!retryableImageStatus.has(response.status) || attempt === imageAttempts) break;
    options.onProgress?.(30, `icompify 图片服务暂不可用（HTTP ${response.status}），${attempt * 2} 秒后重试`);
    await delay(signal, attempt * 2_000);
  }
  throw new Error(`icompify 图片请求失败（已尝试 ${imageAttempts} 次）：${lastError}`);
}

function readIcompifyImage(text: string, model: string, started: number): ImageResult {
  let data: { model?: string; choices?: { message?: { content?: { type?: string; image_url?: { url?: string }; stage_durations?: { stage_0_gen_ms?: number } }[] | string } }[] };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    throw new Error(`icompify 返回非 JSON：${text.slice(0, 300)}`);
  }
  const content = data.choices?.[0]?.message?.content;
  const parts = Array.isArray(content) ? content : [];
  const part = parts.find(item => item.image_url?.url);
  const url = part?.image_url?.url ?? "";
  if (!url) {
    const plain = typeof content === "string" ? content.slice(0, 200) : JSON.stringify(content ?? "").slice(0, 200);
    throw new Error(`icompify 未返回图片：${plain}`);
  }
  const genMs = Number(part?.stage_durations?.stage_0_gen_ms);
  const seconds = Number.isFinite(genMs) && genMs > 0 ? Math.round(genMs) / 1000 : Math.round(Date.now() - started) / 1000;
  const inline = dataUriBytes(url);
  if (inline) {
    if (!inline.bytes.byteLength) throw new Error("icompify 返回的图片数据为空");
    return { bytes: inline.bytes, mimeType: inline.mimeType, model: data.model ?? model, backend: "icompify", seconds };
  }
  throw new Error(`icompify 返回的不是内联图片数据：${url.slice(0, 120)}`);
}

async function generateViaApi(options: GenerateImageOptions, settings: Settings, api: "openai" | "openrouter"): Promise<ImageResult> {
  const baseUrl = settings.image.baseUrl.trim().replace(/\/+$/, "");
  const model = settings.image.model.trim();
  const size = resolveSize(options.size ?? settings.image.size, options.ratio ?? "16:9");
  const timeout = AbortSignal.timeout(300_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const endpoint = api === "openrouter" ? `${baseUrl}/images` : `${baseUrl}/images/generations`;
  const body: Record<string, unknown> = { model, prompt: options.prompt, n: 1, size };
  if (api !== "openrouter") body.response_format = "b64_json";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(settings.image.apiKey ? { Authorization: `Bearer ${settings.image.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`图片模型请求失败（HTTP ${response.status}）：${text.slice(0, 500)}`);
  const data = JSON.parse(text) as { data?: { b64_json?: string; url?: string; media_type?: string }[] };
  const item = data.data?.[0];
  if (item?.b64_json) {
    return { bytes: new Uint8Array(Buffer.from(item.b64_json, "base64")), mimeType: item.media_type ?? "image/png", model, backend: api };
  }
  if (item?.url) {
    const image = await fetch(item.url, { signal });
    if (!image.ok) throw new Error(`下载生成图片失败：HTTP ${image.status}`);
    const mimeType = item.media_type ?? (image.headers.get("content-type") ?? "image/png").split(";")[0];
    return { bytes: new Uint8Array(await image.arrayBuffer()), mimeType, model, backend: api };
  }
  throw new Error("图片模型未返回图片数据");
}

/** qwen_image_gen2.py 的进度行里会混着 tqdm 输出，只挑 {"results":[...]} 那一行。 */
function parseLocalOutput(stdout: string) {
  let seconds: number | undefined;
  let size: { width?: number; height?: number } = {};
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes("\"results\"")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { results?: { seconds?: number; width?: number; height?: number }[] };
      const first = parsed.results?.[0];
      if (first) {
        seconds = first.seconds;
        size = { width: first.width, height: first.height };
      }
    } catch {
      // 进度行里也可能出现 {，忽略解析失败
    }
  }
  return { seconds, ...size };
}

/** 本地后端的模型标识：用脚本文件名，避免把某个具体模型名写死。 */
function localModelLabel(script: string, host?: string) {
  const name = script.split("/").filter(Boolean).pop() || "local-script";
  return host ? `${name}@${host}` : `${name}@local`;
}

function localArgs(options: GenerateImageOptions, settings: Settings, outPath: string, width: number, height: number, references: string[]) {
  const local = settings.image.local;
  return [
    local.pythonBin,
    local.script,
    "-p", options.prompt,
    "-o", outPath,
    "--width", String(width),
    "--height", String(height),
    "--steps", String(local.steps),
    "--vram", local.vram,
    ...references.flatMap(ref => ["--ref", ref]),
  ];
}

/**
 * 本机直连：直接 Bun.spawn qwen_image_gen2.py，跳过 SSH/scp。
 * 只有 StyleLoom 与脚本同机时才有意义；省掉上传/下载与远端进程启动，设备内耗时不变。
 */
async function generateViaDirect(options: GenerateImageOptions, settings: Settings): Promise<ImageResult> {
  const local = settings.image.local;
  const { width, height } = resolveLocalSize(local.shortEdge, options.ratio ?? "16:9");
  const references = (options.references ?? []).filter(Boolean);
  for (const reference of references) {
    if (!(await exists(reference))) throw new Error(`条件图不存在：${reference}`);
  }

  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const dir = join(dataDir, "cache", "image", tag);
  const outPath = join(dir, "out.png");
  await ensureDir(dir);
  const timeout = AbortSignal.timeout(local.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    options.onProgress?.(8, references.length ? `本机准备 ${references.length} 张条件图` : "启动本机出图");
    options.onProgress?.(25, `本机出图中（${width}x${height} / ${local.steps} 步）`);
    const result = await runProcess(localArgs(options, settings, outPath, width, height, references), {
      cwd: local.workdir.trim() || undefined,
      signal,
    });
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("已取消");
    if (timeout.aborted) throw new Error(`本机出图超时（${Math.round(local.timeoutMs / 1000)}s）`);
    if (result.code !== 0) {
      const detail = (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-6).join("\n");
      throw new Error(`qwen_image_gen2.py 执行失败（退出码 ${result.code}）：${detail || "无错误输出"}`);
    }
    options.onProgress?.(88, "读取图片");
    const bytes = new Uint8Array(await Bun.file(outPath).arrayBuffer());
    return { bytes, mimeType: "image/png", model: localModelLabel(local.script), backend: "local", ...parseLocalOutput(result.stdout) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 远端 SSH 出图（StyleLoom 与脚本不同机时用）。
 * 条件图上传 → 远端跑 qwen_image_gen2.py → 拉回 PNG；支持多张条件图（vision 通道，不做 img2img 加噪）。
 */
async function generateViaSsh(options: GenerateImageOptions, settings: Settings): Promise<ImageResult> {
  const local = settings.image.local;
  const host = local.host.trim();
  const sshBin = local.sshBin.trim() || "ssh";
  const scpBin = local.scpBin.trim() || "scp";
  const { width, height } = resolveLocalSize(local.shortEdge, options.ratio ?? "16:9");
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const signal = options.signal;
  const timeoutMs = local.timeoutMs;
  const references = (options.references ?? []).filter(Boolean);

  options.onProgress?.(8, "连接远端主机");
  return withRemoteWorkdir({ sshBin, host, workdir: local.workdir, tag, signal, timeoutMs }, async remoteDir => {
    const remoteRefs: string[] = [];
    for (const [index, reference] of references.entries()) {
      if (!(await exists(reference))) throw new Error(`条件图不存在：${reference}`);
      const extension = reference.toLowerCase().endsWith(".jpg") || reference.toLowerCase().endsWith(".jpeg") ? ".jpg" : ".png";
      const remotePath = `${remoteDir}/ref${index}${extension}`;
      options.onProgress?.(12 + index * 4, `上传条件图 ${index + 1}/${references.length}`);
      await scpToRemote(scpBin, host, reference, remotePath, { signal, timeoutMs });
      remoteRefs.push(remotePath);
    }

    const remoteOut = `${remoteDir}/out.png`;
    const args = [
      local.pythonBin,
      local.script,
      "-p", options.prompt,
      "-o", remoteOut,
      "--width", String(width),
      "--height", String(height),
      "--steps", String(local.steps),
      "--vram", local.vram,
      ...remoteRefs.flatMap(ref => ["--ref", ref]),
    ];
    const command = `cd ${shellQuote(local.workdir)} && ${args.map(shellQuote).join(" ")}`;
    options.onProgress?.(25, `本机出图中（${width}x${height} / ${local.steps} 步）`);
    const stdout = await sshRun(sshBin, host, command, { signal, timeoutMs });

    options.onProgress?.(88, "拉回图片");
    const fetched = await fetchRemoteFile({ scpBin, host, remotePath: remoteOut, fileName: "out.png", signal, timeoutMs });
    try {
      const bytes = new Uint8Array(await Bun.file(fetched.path).arrayBuffer());
      return {
        bytes,
        mimeType: "image/png",
        model: localModelLabel(local.script, host),
        backend: "local" as const,
        ...parseLocalOutput(stdout),
      };
    } finally {
      await rm(fetched.dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

async function generateViaLocal(options: GenerateImageOptions, settings: Settings): Promise<ImageResult> {
  const mode = await localImageMode(settings);
  if (mode === "direct") return generateViaDirect(options, settings);
  if (mode === "ssh") return generateViaSsh(options, settings);
  throw new Error("本地图片后端未配置完整：direct 模式需要本机 script 与 pythonBin，ssh 模式需要 host、script 与 pythonBin");
}

/** 本地后端连通性自检：direct 只查本机文件，ssh 只跑一条 ssh true；都不加载模型、不占显存。 */
export async function checkLocalImage(settings: Settings, signal?: AbortSignal) {
  const local = settings.image.local;
  const mode = await localImageMode(settings);
  if (mode === "direct") {
    const files = await localImageFiles(settings);
    if (files.script && files.python) return { ok: true, message: `本机直连就绪（${local.script}）` };
    const missing = [!files.script ? "脚本" : "", !files.python ? "Python" : ""].filter(Boolean).join("与");
    return { ok: false, message: `本机直连缺少${missing}：${local.script} / ${local.pythonBin}` };
  }
  if (mode === "ssh") {
    const reachable = await localImageReachable(settings, signal);
    if (!reachable) return { ok: false, message: `无法免密登录 ${local.host}（检查网络、SSH 配置与密钥）` };
    const scriptExists = await sshRun(local.sshBin || "ssh", local.host.trim(), `test -f ${shellQuote(local.script)} && echo yes || echo no`, { signal, timeoutMs: 20_000 })
      .then(output => output.trim() === "yes")
      .catch(() => false);
    if (!scriptExists) return { ok: false, message: `${local.host} 上找不到出图脚本：${local.script}` };
    return { ok: true, message: `${local.host} 可达，脚本就绪（${local.script}）` };
  }
  return { ok: false, message: "未配置本地出图：可填本机 script/pythonBin（direct）或 host（ssh）" };
}

/**
 * 统一的出图入口。
 * 未配置任何后端时返回 null，由调用方回退到「从参考片抽帧」。
 */
export async function generateImageWithModel(options: GenerateImageOptions): Promise<ImageResult | null> {
  const settings = await loadSettings();
  applyLocalImageEnv(settings);
  const backend = await resolveImageBackend({ signal: options.signal, onProgress: options.onProgress });
  if (!backend) return null;
  if (backend === "local") {
    const result = await generateViaLocal(options, settings);
    options.onProgress?.(100, "图片已生成");
    return result;
  }
  if (backend === "icompify") {
    const result = await generateViaIcompify(options, settings);
    options.onProgress?.(100, "图片已生成");
    return result;
  }
  options.onProgress?.(20, "请求图片模型");
  const result = await generateViaApi(options, settings, backend);
  options.onProgress?.(100, "图片已生成");
  return result;
}
