import { loadSettings } from "../config";
import { sshRun, shellQuote } from "../util/ssh";
import { exists } from "../util/fs";
import { applyLocalImageEnv, localImageFiles, localImageMode, localImageReachable } from "./image";

export type ImageBackendName = "openrouter" | "openai" | "local";

/** 依次尝试的环境变量名里取第一个非空值。 */
function pickFromEnv(names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

/** 图片后端自检：direct 只查本机文件，ssh 只跑 ssh true；不加载模型、不占显存、不计费。 */
export async function checkImageBackend(signal?: AbortSignal) {
  const settings = await loadSettings();
  applyLocalImageEnv(settings);
  const { api, baseUrl, model, local } = settings.image;
  const lines: string[] = [];
  let ok = false;

  const mode = await localImageMode(settings);
  const wantsLocal = api === "local" || (api === "auto" && Boolean(mode));
  const wantsRemote = api !== "local" && Boolean(baseUrl && model);
  const script = local.script.trim();
  const pythonBin = local.pythonBin.trim();

  if (wantsLocal) {
    if (mode === "direct") {
      const files = await localImageFiles(settings);
      if (files.script && files.python) {
        lines.push(`本地出图：本机直连就绪（${script}）`);
        ok = true;
      } else {
        const missing = [!files.script ? "脚本" : "", !files.python ? "Python" : ""].filter(Boolean).join("与");
        lines.push(`本地出图：本机直连缺少${missing}（${script} / ${pythonBin}）`);
      }
    } else if (mode === "ssh") {
      try {
        // python 可能是绝对路径，也可能是 PATH 里的命令名，两种都算就绪。
        const remote = `test -f ${shellQuote(script)} && { test -x ${shellQuote(pythonBin)} || command -v ${shellQuote(pythonBin)} >/dev/null 2>&1; } && echo ready`;
        const stdout = await sshRun(local.sshBin || "ssh", local.host.trim(), remote, { signal, timeoutMs: 20_000 });
        const reachable = await localImageReachable(settings, signal);
        if (!reachable) {
          lines.push(`本地出图：无法免密登录 ${local.host}`);
        } else if (stdout.includes("ready")) {
          lines.push(`本地出图：SSH 可达（${local.host}，脚本与 Python 均就绪）`);
          ok = true;
        } else {
          lines.push(`本地出图：SSH 可达但脚本或 Python 路径不对（${script}）`);
        }
      } catch (error) {
        lines.push(`本地出图：不可用（${(error as Error).message.slice(0, 200)}）`);
      }
    } else {
      lines.push("本地出图：未配置（direct 需要本机 script 与 pythonBin；ssh 需要 host）");
    }
  }

  const apiKey = pickFromEnv(["IMAGEGEN_API_KEY", "IMAGE_GEN_API_KEY", "OPENROUTER_API_KEY"]) ?? settings.image.apiKey;
  if (wantsRemote) {
    if (apiKey) {
      lines.push(`远程图片模型：已配置（${model} @ ${baseUrl}）`);
      ok = true;
    } else {
      lines.push(`远程图片模型：缺少 API Key（${model}）`);
    }
  } else if (api !== "local") {
    lines.push("远程图片模型：未配置");
  }

  return { ok, detail: lines.join("；") };
}

/**
 * 真实出一张最小的图，用来验证「本机 spawn / SSH → 脚本 → 产物」整条链路。
 * 会占用本地显存并排队，所以只在显式调用时执行。
 */
export async function probeLocalImage(options: { prompt?: string; ratio?: string; reference?: string; signal?: AbortSignal } = {}) {
  const settings = await loadSettings();
  applyLocalImageEnv(settings);
  const { generateImageWithModel } = await import("./image");
  const references = options.reference && (await exists(options.reference)) ? [options.reference] : [];
  const started = Date.now();
  const previousApi = settings.image.api;
  // 自检必须真的打本地后端，不能在不可用时静默回退到计费远程接口。
  settings.image.api = "local";
  const image = await generateImageWithModel({
    prompt: options.prompt ?? "a single ripe orange on a clean white table, soft studio light, 50mm",
    ratio: options.ratio ?? "16:9",
    references,
    signal: options.signal,
  }).finally(() => {
    settings.image.api = previousApi;
  });
  if (!image) throw new Error("没有可用的图片后端（既没配本地出图，也没配远程图片模型）");
  return {
    backend: image.backend,
    model: image.model,
    bytes: image.bytes.length,
    width: image.width,
    height: image.height,
    remoteSeconds: image.seconds,
    totalMs: Date.now() - started,
    mode: await localImageMode(settings),
    references: references.length,
  };
}
