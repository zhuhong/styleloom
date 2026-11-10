import { loadSettings } from "../config";

export type ImageResult = { bytes: Uint8Array; mimeType: string; model: string };

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

/**
 * 通过 OpenAI 兼容的 /images/generations 或 OpenRouter 的 /images 出图。
 * 未配置图片模型时返回 null，由调用方回退到「从参考片抽帧」。
 */
export async function generateImageWithModel(options: {
  prompt: string;
  size?: string;
  ratio?: string;
  signal?: AbortSignal;
}): Promise<ImageResult | null> {
  const settings = await loadSettings();
  const baseUrl = settings.image.baseUrl.trim().replace(/\/+$/, "");
  const model = settings.image.model.trim();
  if (!baseUrl || !model) return null;
  const api = settings.image.api === "auto"
    ? (/openrouter\.ai/i.test(baseUrl) ? "openrouter" : "openai")
    : settings.image.api;
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
    return { bytes: new Uint8Array(Buffer.from(item.b64_json, "base64")), mimeType: item.media_type ?? "image/png", model };
  }
  if (item?.url) {
    const image = await fetch(item.url, { signal });
    if (!image.ok) throw new Error(`下载生成图片失败：HTTP ${image.status}`);
    const mimeType = item.media_type ?? (image.headers.get("content-type") ?? "image/png").split(";")[0];
    return { bytes: new Uint8Array(await image.arrayBuffer()), mimeType, model };
  }
  throw new Error("图片模型未返回图片数据");
}
