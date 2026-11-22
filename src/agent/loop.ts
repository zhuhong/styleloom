import { loadSettings } from "../config";
import { chat, type LlmMessage } from "../providers/llm";
import { getProject, readSession, saveProjectMergingRender, writeSession } from "../store/projects";
import type { AgentEvent, ChatAttachment } from "../types";
import { buildSystemPrompt } from "./prompt";
import { executeTool, toolSpecs, type ToolContext } from "./tools";

const MAX_STEPS = 14;
const MAX_MESSAGES = 48;

function sanitizeMessages(messages: LlmMessage[]) {
  const output: LlmMessage[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "assistant" && message.tool_calls?.length) {
      const expected = new Set(message.tool_calls.map(call => call.id));
      const results: LlmMessage[] = [];
      let next = index + 1;
      while (next < messages.length && messages[next].role === "tool") {
        results.push(messages[next]);
        next += 1;
      }
      const valid = results.filter(result => expected.has(result.tool_call_id ?? ""));
      if (valid.length === expected.size) output.push(message, ...valid);
      else if (typeof message.content === "string" && message.content.trim()) output.push({ role: "assistant", content: message.content });
      index = next - 1;
      continue;
    }
    // ACT: 中断时可能留下孤立的 tool 消息，直接丢弃，避免下一轮请求 400。
    if (message.role === "tool") continue;
    output.push(message);
  }
  return output;
}

/** 工具返回「需要用户确认」时，转成前端可渲染的确认事件；目前只有 generate_shot 走这条路。 */
export function confirmationRequest(name: string, payload: unknown): AgentEvent | undefined {
  if (name !== "generate_shot") return undefined;
  if (!payload || typeof payload !== "object") return undefined;
  const data = payload as { requiresConfirmation?: unknown; shotId?: unknown; title?: unknown; durationSeconds?: unknown; force?: unknown };
  if (data.requiresConfirmation !== true || typeof data.shotId !== "string") return undefined;
  return {
    type: "confirmation",
    id: `confirm-${data.shotId}`,
    action: "submit_shot",
    shotId: data.shotId,
    title: typeof data.title === "string" ? data.title : data.shotId,
    durationSeconds: typeof data.durationSeconds === "number" ? data.durationSeconds : undefined,
    force: data.force === true,
  };
}

function attachmentBlock(attachments: ChatAttachment[]) {
  const lines = attachments.map(attachment => `- ${attachment.kind === "image" ? "图片" : "视频"}：${attachment.path}${attachment.label ? `（原始文件名：${attachment.label}）` : ""}`);
  return `[用户上传素材]\n${lines.join("\n")}\n这些是项目内相对路径；需要作为参考时，用 list_assets 查看，再用 set_shot_references 绑定到具体分镜（图片 role=subject/location，视频放 videos；首帧/尾帧用 firstFrame/lastFrame）。`;
}

function trimMessages(messages: LlmMessage[]) {
  if (messages.length <= MAX_MESSAGES) return messages;
  let start = messages.length - MAX_MESSAGES;
  while (start < messages.length && messages[start].role !== "user") start++;
  if (start >= messages.length) return messages.slice(-MAX_MESSAGES);
  return messages.slice(start);
}

/** 执行一轮对话：LLM ↔ 工具循环，事件通过 emit 实时推给前端/CLI。 */
export async function runAgentTurn(
  projectId: string,
  userMessage: string,
  emit: (event: AgentEvent) => void,
  signal: AbortSignal,
  attachments: ChatAttachment[] = [],
) {
  const project = await getProject(projectId);
  const settings = await loadSettings();
  const messages = await readSession<LlmMessage>(projectId);
  messages.push({ role: "user", content: userMessage, ...(attachments.length ? { attachments } : {}) });
  emit({ type: "message", role: "user", content: userMessage, ...(attachments.length ? { attachments } : {}) });

  const meta = { deleted: false };
  const ctx: ToolContext = {
    project,
    settings,
    emit,
    signal,
    meta,
    save: async () => {
      if (meta.deleted) return;
      await saveProjectMergingRender(project);
      // 每个工具写完盘就广播一次 state，不要等到整轮结束。
      // 否则 Agent 一轮里连调 update_brief → study_reference_video → plan_shots 时，
      // 右侧「概览」的需求卡片要等学习跑完（几分钟）才刷新。
      emit({ type: "state", project });
    },
  };

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      signal.throwIfAborted();
      const messageId = crypto.randomUUID();
      let streamed = false;
      const result = await chat({
        messages: [
          { role: "system", content: await buildSystemPrompt(project, settings) },
          ...trimMessages(sanitizeMessages(messages)).map(message => {
            if (message.role !== "user" || !message.attachments?.length) return message;
            const { attachments, ...rest } = message;
            const content = typeof rest.content === "string" ? rest.content : "";
            return { ...rest, content: `${content}${content ? "\n\n" : ""}${attachmentBlock(attachments)}` };
          }),
        ],
        // 项目已删：只允许收尾文本，不再暴露会写盘的工具。
        tools: meta.deleted ? undefined : toolSpecs,
        signal,
        onDelta: delta => {
          if (!streamed) {
            streamed = true;
            emit({ type: "message_start", id: messageId, role: "assistant" });
          }
          emit({ type: "message_delta", id: messageId, delta });
        },
      });
      const content = result.content.trim();
      if (streamed) {
        emit({ type: "message_end", id: messageId });
      } else if (content) {
        // 非流式回退或空增量：整段一次推送。
        emit({ type: "message", role: "assistant", content });
      }
      if (!result.toolCalls.length || meta.deleted) {
        messages.push({ role: "assistant", content });
        break;
      }
      messages.push({ role: "assistant", content, tool_calls: result.toolCalls });
      for (const call of result.toolCalls) {
        signal.throwIfAborted();
        if (meta.deleted) break;
        const callId = call.id || crypto.randomUUID();
        let parsedArgs: unknown = call.function.arguments;
        try {
          parsedArgs = JSON.parse(call.function.arguments || "{}");
        } catch {
          parsedArgs = call.function.arguments;
        }
        emit({ type: "tool_start", id: callId, name: call.function.name, args: parsedArgs });
        const startedAt = Date.now();
        let payload: unknown;
        let ok = true;
        // 进度事件统一绑定到当前 tool call，前端按 callId 更新卡片。
        const callCtx: ToolContext = {
          ...ctx,
          emit: event => emit(event.type === "progress" ? { ...event, scope: callId } : event),
        };
        try {
          payload = await executeTool(call.function.name, call.function.arguments ?? "", callCtx);
          if (payload && typeof payload === "object" && "ok" in payload && (payload as { ok?: unknown }).ok === false) ok = false;
        } catch (error) {
          ok = false;
          payload = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        const serialized = JSON.stringify(payload);
        // 需要用户确认的计费操作：额外推一条结构化事件，前端渲染提交/取消按钮。
        const confirmation = confirmationRequest(call.function.name, payload);
        if (confirmation) emit(confirmation);
        emit({ type: "tool_end", id: callId, name: call.function.name, ok, preview: serialized.slice(0, 800), elapsedMs: Date.now() - startedAt });
        messages.push({
          role: "tool",
          tool_call_id: callId,
          name: call.function.name,
          content: serialized.slice(0, 24_000),
        });
        if (!meta.deleted) await saveProjectMergingRender(project);
      }
      // 删除成功后进入下一轮，让模型用纯文本收尾，然后在上面的分支结束。
      if (meta.deleted) continue;
      if (step === MAX_STEPS - 1) {
        emit({ type: "message", role: "assistant", content: "本轮工具调用次数已达上限，我先停在这里。请告诉我下一步。" });
      }
    }
  } finally {
    if (!meta.deleted) {
      await writeSession(projectId, trimMessages(sanitizeMessages(messages)));
      await saveProjectMergingRender(project);
      emit({ type: "state", project });
    }
  }
}
