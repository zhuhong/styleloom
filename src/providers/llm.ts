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
  /** 流式增量回调；提供时走 SSE stream，正文边生成边推。 */
  onDelta?: (delta: string) => void;
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

type ChatResult = { content: string; toolCalls: LlmToolCall[] };

function normalizeToolCalls(raw: LlmToolCall[] | undefined): LlmToolCall[] {
  return (raw ?? [])
    .filter(call => call?.function?.name)
    .map(call => ({
      id: call.id || crypto.randomUUID(),
      type: "function" as const,
      function: {
        name: call.function.name,
        arguments: typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}),
      },
    }));
}

async function chatOnce(options: ChatOptions, stream: boolean): Promise<ChatResult> {
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
    stream,
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
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`语言模型请求失败（HTTP ${response.status}）：${text.slice(0, 500)}`);
  }

  if (!stream) {
    const text = await response.text();
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
      toolCalls: normalizeToolCalls(message.tool_calls),
    };
  }

  if (!response.body) throw new Error("语言模型未返回流式响应体");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let data: {
      choices?: {
        delta?: {
          content?: string | null;
          tool_calls?: {
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }[];
        };
        message?: { content?: string | null; tool_calls?: LlmToolCall[] };
      }[];
      error?: { message?: string };
    };
    try {
      data = JSON.parse(payload);
    } catch {
      return;
    }
    if (data.error?.message) throw new Error(`语言模型返回错误：${data.error.message}`);
    const choice = data.choices?.[0];
    const deltaText = choice?.delta?.content;
    if (typeof deltaText === "string" && deltaText) {
      content += deltaText;
      options.onDelta?.(deltaText);
    }
    for (const part of choice?.delta?.tool_calls ?? []) {
      const index = typeof part.index === "number" ? part.index : 0;
      const current = toolAcc.get(index) ?? { id: "", name: "", arguments: "" };
      if (part.id) current.id = part.id;
      if (part.function?.name) current.name += part.function.name;
      if (typeof part.function?.arguments === "string") current.arguments += part.function.arguments;
      toolAcc.set(index, current);
    }
    // 少数网关在 stream 末尾仍给完整 message，作兜底。
    if (choice?.message?.content && !content) content = choice.message.content;
    if (choice?.message?.tool_calls?.length && !toolAcc.size) {
      for (const [index, call] of choice.message.tool_calls.entries()) {
        toolAcc.set(index, {
          id: call.id || "",
          name: call.function?.name || "",
          arguments: typeof call.function?.arguments === "string" ? call.function.arguments : "",
        });
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      consumeLine(line);
    }
  }
  if (buffer.trim()) consumeLine(buffer);

  const toolCalls = [...toolAcc.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, call]) => ({
      id: call.id || crypto.randomUUID(),
      type: "function" as const,
      function: { name: call.name, arguments: call.arguments },
    }))
    .filter(call => call.function.name);

  return { content, toolCalls };
}

export async function chat(options: ChatOptions): Promise<ChatResult> {
  // 有 onDelta 时优先流式；若在收到任何增量前就失败（网关不支持 stream），再回退非流式。
  if (options.onDelta) {
    let started = false;
    try {
      return await chatOnce({
        ...options,
        onDelta: delta => {
          started = true;
          options.onDelta?.(delta);
        },
      }, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (started || /abort/i.test(message)) throw error;
      return chatOnce({ ...options, onDelta: undefined }, false);
    }
  }
  return chatOnce(options, false);
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
