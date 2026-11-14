import { rm } from "node:fs/promises";
import { loadSettings, type Settings } from "../config";
import { exists } from "../util/fs";
import { fetchRemoteFile, scpToRemote, shellQuote, sshReachable, sshRun, withRemoteWorkdir } from "../util/ssh";

export type ImageBackend = "openrouter" | "openai" | "local";

export type ImageResult = {
  bytes: Uint8Array;
  mimeType: string;
  model: string;
  backend: ImageBackend;
  /** 5090 出图耗时（秒），只有 local 后端有 */
  seconds?: number;
  width?: number;
  height?: number;
};

export type ImageProgress = (percent: number, label: string) => void;

export type GenerateImageOptions = {
  prompt: string;
  size?: string;
  ratio?: string;
  /** 参考图（绝对路径）；只有 5090 本地后端真正支持多张条件图 */
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

function pickApi(settings: Settings): ImageBackend {
  const baseUrl = settings.image.baseUrl.trim();
  if (settings.image.api === "local" || settings.image.api === "openrouter" || settings.image.api === "openai") {
    return settings.image.api;
  }
  // auto：配了 5090 就优先本地（免费），否则按 baseUrl 猜远程形态。
  if (localImageConfigured(settings)) return "local";
  return /openrouter\.ai/i.test(baseUrl) ? "openrouter" : "openai";
}

/** local 后端是否配置齐全（host + script）。 */
export function localImageConfigured(settings: Settings) {
  const local = settings.image.local;
  return Boolean(local.host.trim() && local.script.trim() && local.pythonBin.trim());
}

/** 远程 5090 是否可免密登录（会真的发一条 ssh true）。 */
export async function localImageReachable(settings: Settings, signal?: AbortSignal) {
  const local = settings.image.local;
  if (!localImageConfigured(settings)) return false;
  return sshReachable(local.sshBin || "ssh", local.host.trim(), signal);
}

/**
 * 决定本次走哪个后端。
 * auto = 配了 5090 且 SSH 可达就用 5090，否则回退到 API 图片模型。
 * local = 只用 5090（失败直接报错，方便暴露问题）。
 */
export async function resolveImageBackend(
  options: { signal?: AbortSignal; onProgress?: ImageProgress } = {},
): Promise<ImageBackend | undefined> {
  const settings = await loadSettings();
  const configured = pickApi(settings);
  const hasApi = Boolean(settings.image.baseUrl.trim() && settings.image.model.trim());
  if (configured !== "local") return hasApi ? configured : undefined;
  // 走到这里说明要用 5090：显式指定就直连（失败直接报错），auto 才做可达性探测。
  if (settings.image.api === "local") return "local";
  options.onProgress?.(3, "探测 5090 是否可达");
  if (await localImageReachable(settings, options.signal)) return "local";
  if (!hasApi) return "local"; // 没配 API 时仍然尝试 5090，让报错更具体
  options.onProgress?.(5, "5090 不可达，回退远程图片模型");
  return /openrouter\.ai/i.test(settings.image.baseUrl) ? "openrouter" : "openai";
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

/**
 * 5090 本地 Qwen-Image-2.1-Turbo 出图。
 * 走 SSH + scp：条件图上传 → 远端跑 qwen_image_gen2.py → 拉回 PNG。
 * 支持多张条件图（走 text-encoder 的 vision 通道，不做 img2img 加噪）。
 */
async function generateViaLocal(options: GenerateImageOptions, settings: Settings): Promise<ImageResult> {
  const local = settings.image.local;
  const host = local.host.trim();
  const sshBin = local.sshBin.trim() || "ssh";
  const scpBin = local.scpBin.trim() || "scp";
  const { width, height } = resolveLocalSize(local.shortEdge, options.ratio ?? "16:9");
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const signal = options.signal;
  const timeoutMs = local.timeoutMs;
  const references = (options.references ?? []).filter(Boolean);

  options.onProgress?.(8, "连接 5090");
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
    options.onProgress?.(25, `5090 出图中（${width}x${height} / ${local.steps} 步）`);
    const stdout = await sshRun(sshBin, host, command, { signal, timeoutMs });

    let seconds: number | undefined;
    let outSize: { width?: number; height?: number } = {};
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{") || !trimmed.includes("\"results\"")) continue;
      try {
        const parsed = JSON.parse(trimmed) as { results?: { seconds?: number; width?: number; height?: number }[] };
        const first = parsed.results?.[0];
        if (first) {
          seconds = first.seconds;
          outSize = { width: first.width, height: first.height };
        }
      } catch {
        // 进度行里也可能出现 {，忽略解析失败
      }
    }

    options.onProgress?.(88, "拉回图片");
    const fetched = await fetchRemoteFile({ scpBin, host, remotePath: remoteOut, fileName: "out.png", signal, timeoutMs });
    try {
      const bytes = new Uint8Array(await Bun.file(fetched.path).arrayBuffer());
      return {
        bytes,
        mimeType: "image/png",
        model: `qwen-image-2.1-turbo@${host}`,
        backend: "local" as const,
        seconds,
        width: outSize.width,
        height: outSize.height,
      };
    } finally {
      await rm(fetched.dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

/** 5090 连通性自检：只跑一条 ssh true，不加载模型、不产生显存占用。 */
export async function checkLocalImage(settings: Settings, signal?: AbortSignal) {
  const local = settings.image.local;
  if (!localImageConfigured(settings)) return { ok: false, message: "未配置 5090 地址或脚本路径" };
  const reachable = await localImageReachable(settings, signal);
  if (!reachable) return { ok: false, message: `无法免密登录 ${local.host}（检查网络、SSH 配置与密钥）` };
  const scriptExists = await sshRun(local.sshBin || "ssh", local.host.trim(), `test -f ${shellQuote(local.script)} && echo yes || echo no`, { signal, timeoutMs: 20_000 })
    .then(output => output.trim() === "yes")
    .catch(() => false);
  if (!scriptExists) return { ok: false, message: `${local.host} 上找不到出图脚本：${local.script}` };
  return { ok: true, message: `${local.host} 可达，脚本就绪（${local.script}）` };
}

/**
 * 统一的出图入口。
 * 未配置任何后端时返回 null，由调用方回退到「从参考片抽帧」。
 */
export async function generateImageWithModel(options: GenerateImageOptions): Promise<ImageResult | null> {
  const settings = await loadSettings();
  // 环境变量只影响「连哪台机器」，用于测试脚本；正常情况下走 data/settings.json。
  const local = settings.image.local;
  local.host = process.env.IMAGEGEN_LOCAL_HOST?.trim() || local.host;
  local.sshBin = process.env.IMAGEGEN_SSH_BIN?.trim() || local.sshBin;
  local.scpBin = process.env.IMAGEGEN_SCP_BIN?.trim() || local.scpBin;
  local.script = process.env.IMAGEGEN_LOCAL_SCRIPT?.trim() || local.script;
  local.pythonBin = process.env.IMAGEGEN_LOCAL_PYTHON?.trim() || local.pythonBin;
  local.workdir = process.env.IMAGEGEN_LOCAL_WORKDIR?.trim() || local.workdir;
  const backend = await resolveImageBackend({ signal: options.signal, onProgress: options.onProgress });
  if (!backend) return null;
  if (backend === "local") {
    if (!localImageConfigured(settings)) {
      throw new Error("5090 图片后端未配置完整：请在设置里填写 image.local.host、script 和 pythonBin");
    }
    const result = await generateViaLocal(options, settings);
    options.onProgress?.(100, "图片已生成");
    return result;
  }
  options.onProgress?.(20, "请求图片模型");
  const result = await generateViaApi(options, settings, backend);
  options.onProgress?.(100, "图片已生成");
  return result;
}
