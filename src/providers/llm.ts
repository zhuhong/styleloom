import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { loadSettings } from "../config";
import type { ChatAttachment } from "../types";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type LlmToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type LlmMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
  name?: string;
  /** 仅用于本地会话/UI；发给模型前会转成文本块并移除该字段。 */
  attachments?: ChatAttachment[];
};

export type ToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ChatOptions = {
  messages: LlmMessage[];
  tools?: ToolSpec[];
  model?: "text" | "vision" | string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
};

/** 模型标识支持别名 text / vision，或直接传供应商模型 id。 */
async function resolveModel(model: string | undefined) {
  const settings = await loadSettings();
  if (!model || model === "text") return settings.llm.model;
  if (model === "vision") return settings.llm.visionModel || settings.llm.model;
  return model;
}

export function mimeFromPath(path: string) {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".m4a" || ext === ".aac") return "audio/mp4";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  return "image/jpeg";
}

export async function imageDataUrl(path: string) {
  const bytes = await readFile(path);
  if (bytes.byteLength > 12 * 1024 * 1024) throw new Error(`参考图过大（>12MB）：${path}`);
  return `data:${mimeFromPath(path)};base64,${Buffer.from(bytes).toString("base64")}`;
}

export async function imageMessage(prompt: string, images: string[]): Promise<ContentPart[]> {
  const parts: ContentPart[] = [{ type: "text", text: prompt }];
  for (const image of images) {
    parts.push({ type: "image_url", image_url: { url: await imageDataUrl(image) } });
  }
  return parts;
}

export async function chat(options: ChatOptions): Promise<{ content: string; toolCalls: LlmToolCall[] }> {
  const settings = await loadSettings();
  if (!settings.llm.baseUrl.trim()) throw new Error("尚未配置语言模型：请在设置里填写 LLM 请求地址");
  if (!settings.llm.model.trim()) throw new Error("尚未配置语言模型 id");
  const endpoint = `${settings.llm.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const model = await resolveModel(options.model);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 300_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const body: Record<string, unknown> = {
    model,
    messages: options.messages.map(({ attachments, ...message }) => message),
    temperature: options.temperature ?? settings.llm.temperature,
    max_tokens: options.maxTokens ?? settings.llm.maxTokens,
  };
  if (options.tools?.length) {
    body.tools = options.tools.map(tool => ({ type: "function", function: tool }));
    body.tool_choice = "auto";
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(settings.llm.apiKey ? { Authorization: `Bearer ${settings.llm.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`语言模型请求失败（HTTP ${response.status}）：${text.slice(0, 500)}`);
  let data: {
    choices?: { message?: { content?: string | null; tool_calls?: LlmToolCall[] } }[];
    error?: { message?: string };
  };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`语言模型返回非 JSON：${text.slice(0, 300)}`);
  }
  if (data.error?.message) throw new Error(`语言模型返回错误：${data.error.message}`);
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error("语言模型未返回有效消息");
  return {
    content: message.content ?? "",
    toolCalls: (message.tool_calls ?? [])
      .filter(call => call?.function?.name)
      .map(call => ({
        id: call.id || crypto.randomUUID(),
        type: "function" as const,
        function: {
          name: call.function.name,
          arguments: typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}),
        },
      })),
  };
}

export function parseJsonLoose<T>(text: string): T {
  const trimmed = text.trim();
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    return JSON.parse(withoutFence) as T;
  } catch {
    const start = withoutFence.indexOf("{");
    const end = withoutFence.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error(`返回内容不是 JSON：${trimmed.slice(0, 200)}`);
    return JSON.parse(withoutFence.slice(start, end + 1)) as T;
  }
}

export async function chatJson<T>(options: {
  system: string;
  prompt: string;
  images?: string[];
  model?: "text" | "vision" | string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ data: T; raw: string }> {
  const content = options.images?.length
    ? await imageMessage(options.prompt, options.images)
    : options.prompt;
  const result = await chat({
    messages: [
      { role: "system", content: options.system },
      { role: "user", content },
    ],
    model: options.model ?? (options.images?.length ? "vision" : "text"),
    temperature: 0.2,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  return { data: parseJsonLoose<T>(result.content), raw: result.content };
}
