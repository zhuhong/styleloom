import { loadSettings } from "../config";
import { sshRun, shellQuote } from "../util/ssh";
import { exists } from "../util/fs";

export type ImageBackendName = "openrouter" | "openai" | "local";

/** 依次尝试的环境变量名里取第一个非空值。 */
function pickFromEnv(names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

/** 图片后端自检：只跑 ssh true + test -f，不加载模型、不占显存、不计费。 */
export async function checkImageBackend(signal?: AbortSignal) {
  const settings = await loadSettings();
  const { api, baseUrl, model, local } = settings.image;
  const lines: string[] = [];
  let ok = false;

  const wantsLocal = api === "local" || api === "auto";
  const wantsRemote = api !== "local" && Boolean(baseUrl && model);
  const host = (pickFromEnv(["IMAGEGEN_LOCAL_HOST", "IMAGE_GEN_LOCAL_HOST"]) ?? local.host).trim();
  const sshBin = (pickFromEnv(["IMAGEGEN_SSH_BIN", "IMAGE_GEN_SSH_BIN"]) ?? local.sshBin).trim() || "ssh";
  const script = (pickFromEnv(["IMAGEGEN_LOCAL_SCRIPT", "IMAGE_GEN_LOCAL_SCRIPT"]) ?? local.script).trim();
  const pythonBin = (pickFromEnv(["IMAGEGEN_LOCAL_PYTHON", "IMAGE_GEN_LOCAL_PYTHON"]) ?? local.pythonBin).trim();

  if (wantsLocal) {
    if (!host || !script || !pythonBin) {
      lines.push("5090：未配置（需要在设置里填 SSH 主机、Python 路径和远程脚本）");
    } else {
      try {
        // python 可能是绝对路径，也可能是 PATH 里的命令名，两种都算就绪。
        const remote = `test -f ${shellQuote(script)} && { test -x ${shellQuote(pythonBin)} || command -v ${shellQuote(pythonBin)} >/dev/null 2>&1; } && echo ready`;
        const stdout = await sshRun(sshBin, host, remote, { signal, timeoutMs: 20_000 });
        if (stdout.includes("ready")) {
          lines.push(`5090：可达（${host}，脚本与 Python 均就绪）`);
          ok = true;
        } else {
          lines.push(`5090：可达但脚本或 Python 路径不对（${script}）`);
        }
      } catch (error) {
        lines.push(`5090：不可用（${(error as Error).message.slice(0, 200)}）`);
      }
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
 * 真实出一张最小的图，用来验证「SSH → 远端脚本 → 拉回」整条链路。
 * 会占用 5090 显存并排队，所以只在显式调用时执行。
 */
export async function probeLocalImage(options: { prompt?: string; ratio?: string; reference?: string; signal?: AbortSignal } = {}) {
  const settings = await loadSettings();
  const { generateImageWithModel } = await import("./image");
  const references = options.reference && (await exists(options.reference)) ? [options.reference] : [];
  const started = Date.now();
  const previousApi = settings.image.api;
  // 自检必须真的打 5090，不能在 SSH 失败时静默回退到计费远程接口。
  settings.image.api = "local";
  const image = await generateImageWithModel({
    prompt: options.prompt ?? "a single ripe orange on a clean white table, soft studio light, 50mm",
    ratio: options.ratio ?? "16:9",
    references,
    signal: options.signal,
  }).finally(() => {
    settings.image.api = previousApi;
  });
  if (!image) throw new Error("没有可用的图片后端（既没配 5090，也没配远程图片模型）");
  return {
    backend: image.backend,
    model: image.model,
    bytes: image.bytes.length,
    width: image.width,
    height: image.height,
    remoteSeconds: image.seconds,
    totalMs: Date.now() - started,
    references: references.length,
  };
}
