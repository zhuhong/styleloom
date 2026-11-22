import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { t } from "../lib/i18n";
import type {
  ChatAttachment,
  ChatItem,
  ChatMessage,
  Project,
  ProjectSummary,
  ToolCardState,
} from "../lib/types";
import { panelScopedTools } from "../lib/panelTools";
import { uid } from "../lib/utils";

type UseAgentChatOptions = {
  getProject: () => Project | null;
  resyncJobs: (projectId: string) => void;
  scheduleRefresh: () => void;
  loadProjects: () => Promise<ProjectSummary[]>;
  selectProject: (id: string) => Promise<void>;
  clearWorkspace: () => void;
  clearPendingUploads: () => void;
  setProject: (updater: Project | null | ((prev: Project | null) => Project | null)) => void;
  resetInspectorUi: () => void;
};

export function useAgentChat({
  getProject,
  resyncJobs,
  scheduleRefresh,
  loadProjects,
  selectProject,
  clearWorkspace,
  clearPendingUploads,
  setProject,
  resetInspectorUi,
}: UseAgentChatOptions) {
  const [chatItems, setChatItems] = useState<ChatItem[]>([]);
  const [streaming, setStreaming] = useState(false);
  const streamingRef = useRef(false);
  const confirmSubmitRef = useRef(false);
  const handleEventRef = useRef<(event: Record<string, unknown>) => void>(() => {});

  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);

  const pushError = useCallback((message: string) => {
    setChatItems(items => [...items, {
      kind: "bubble",
      id: uid("err"),
      role: "assistant",
      content: message,
      isError: true,
    }]);
  }, []);

  const pushBubble = useCallback((role: "user" | "assistant", content: string, attachments: ChatAttachment[] = [], isError = false) => {
    setChatItems(items => [...items, {
      kind: "bubble",
      id: uid("msg"),
      role,
      content,
      attachments,
      isError,
    }]);
  }, []);

  const resetChatFromHistory = useCallback((messages: ChatMessage[]) => {
    setChatItems((messages || []).map(message => ({
      kind: "bubble" as const,
      id: uid("hist"),
      role: message.role,
      content: message.content,
      attachments: message.attachments || [],
    })));
  }, []);

  const clearChat = useCallback(() => {
    setChatItems([]);
  }, []);

  const handleEvent = useCallback((event: Record<string, unknown>) => {
    if (event.type === "message") {
      if (event.role === "user") return;
      pushBubble("assistant", String(event.content ?? ""), (event.attachments as ChatAttachment[]) || []);
      return;
    }
    if (event.type === "message_start") {
      const id = String(event.id ?? "");
      if (!id) return;
      setChatItems(items => items.some(item => item.kind === "bubble" && item.id === id)
        ? items
        : [...items, {
          kind: "bubble",
          id,
          role: "assistant",
          content: "",
          streaming: true,
        }]);
      return;
    }
    if (event.type === "message_delta") {
      const id = String(event.id ?? "");
      const delta = String(event.delta ?? "");
      if (!id || !delta) return;
      setChatItems(items => {
        const index = items.findIndex(item => item.kind === "bubble" && item.id === id);
        if (index < 0) {
          return [...items, {
            kind: "bubble" as const,
            id,
            role: "assistant" as const,
            content: delta,
            streaming: true,
          }];
        }
        const current = items[index];
        if (current.kind !== "bubble") return items;
        const next = items.slice();
        next[index] = { ...current, content: current.content + delta, streaming: true };
        return next;
      });
      return;
    }
    if (event.type === "message_end") {
      const id = String(event.id ?? "");
      if (!id) return;
      setChatItems(items => items.map(item => (
        item.kind === "bubble" && item.id === id
          ? { ...item, streaming: false }
          : item
      )));
      return;
    }
    if (event.type === "confirmation") {
      const shotId = String(event.shotId ?? "");
      if (!shotId) return;
      const id = String(event.id ?? `confirm-${shotId}`);
      setChatItems(items => items.some(item => item.kind === "confirm" && item.id === id)
        ? items
        : [...items, {
          kind: "confirm",
          id,
          shotId,
          title: String(event.title ?? shotId),
          durationSeconds: typeof event.durationSeconds === "number" ? event.durationSeconds : undefined,
          force: event.force === true,
          status: "pending",
        }]);
      return;
    }
    if (event.type === "tool_start") {
      const card: ToolCardState = {
        id: String(event.id),
        name: String(event.name),
        args: event.args,
        status: "running",
        percent: 0,
        label: t("tool.preparing"),
        panel: panelScopedTools.has(String(event.name)),
        startedAt: performance.now(),
      };
      setChatItems(items => [...items, { kind: "tool", id: card.id, card }]);
      return;
    }
    if (event.type === "progress") {
      const scope = String(event.scope ?? "");
      setChatItems(items => items.map(item => {
        if (item.kind !== "tool" || item.id !== scope || item.card.panel) return item;
        return {
          ...item,
          card: {
            ...item.card,
            percent: Number(event.percent) || 0,
            label: String(event.label ?? item.card.label),
          },
        };
      }));
      return;
    }
    if (event.type === "tool_end") {
      const id = String(event.id);
      const toolName = String(event.name ?? "");
      setChatItems(items => items.map(item => {
        if (item.kind !== "tool" || item.id !== id) return item;
        const startedAt = item.card.startedAt;
        const fallback = Number.isFinite(startedAt) ? performance.now() - startedAt : 0;
        const elapsed = Number.isFinite(Number(event.elapsedMs)) ? Number(event.elapsedMs) : fallback;
        return {
          ...item,
          card: {
            ...item.card,
            status: event.ok ? "done" : "failed",
            percent: event.ok ? 100 : item.card.percent,
            preview: String(event.preview ?? ""),
            elapsedMs: elapsed,
          },
        };
      }));
      // generate_shot / resume_shot 入队后立刻拉渲染队列，不等本轮对话结束。
      if (event.ok && (toolName === "generate_shot" || toolName === "resume_shot")) {
        const projectId = getProject()?.id;
        if (projectId) resyncJobs(projectId);
      }
      return;
    }
    if (event.type === "state") {
      setProject(event.project as Project);
      scheduleRefresh();
      return;
    }
    if (event.type === "project_deleted") {
      const deletedId = String(event.id ?? "");
      void loadProjects().then(async list => {
        if (getProject()?.id === deletedId) {
          clearPendingUploads();
          resetInspectorUi();
          if (list.length) await selectProject(list[0].id);
          else clearWorkspace();
        }
      }).catch(error => pushError(t("errors.deleteProject", { message: (error as Error).message })));
      return;
    }
    if (event.type === "error") {
      pushError(t("errors.generic", { message: String(event.message ?? "") }));
    }
  }, [
    clearPendingUploads,
    clearWorkspace,
    getProject,
    loadProjects,
    pushBubble,
    pushError,
    resetInspectorUi,
    resyncJobs,
    scheduleRefresh,
    selectProject,
    setProject,
  ]);

  useEffect(() => {
    handleEventRef.current = handleEvent;
  }, [handleEvent]);

  const sendMessage = useCallback(async (message: string, attachments: ChatAttachment[] = []) => {
    const current = getProject();
    if (!current) {
      pushError(t("errors.needProject"));
      return;
    }
    setStreaming(true);
    if (!message.startsWith("[确认卡片]")) pushBubble("user", message, attachments);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(current.id)}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, attachments }),
      });
      if (!response.ok || !response.body) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              handleEvent(JSON.parse(line.slice(5).trim()));
            } catch {
              // ignore malformed SSE lines
            }
          }
        }
      }
    } catch (error) {
      pushError(t("errors.requestFailed", { message: (error as Error).message }));
    } finally {
      setStreaming(false);
      scheduleRefresh();
      resyncJobs(current.id);
    }
  }, [getProject, handleEvent, pushBubble, pushError, resyncJobs, scheduleRefresh]);

  const tryStartConfirmSubmit = useCallback(() => {
    if (confirmSubmitRef.current || streamingRef.current) return false;
    confirmSubmitRef.current = true;
    return true;
  }, []);

  const handleConfirmSubmit = useCallback((item: { id: string; shotId: string; title: string; durationSeconds?: number; force?: boolean }) => {
    if (!tryStartConfirmSubmit()) return;
    setChatItems(items => items.map(entry => (
      entry.kind === "confirm" && entry.id === item.id ? { ...entry, status: "submitted" } : entry
    )));
    const duration = item.durationSeconds ? `，durationSeconds=${item.durationSeconds}` : "";
    const force = item.force ? "，force=true（用户已同意丢弃旧任务、二次计费）" : "";
    void sendMessage(
      `[确认卡片] 用户已点击「提交」：shotId=${item.shotId}${duration}${force}。请立刻用 generate_shot(confirmed=true) 提交，不要重新问确认。`,
      [],
    ).finally(() => {
      confirmSubmitRef.current = false;
    });
  }, [sendMessage, tryStartConfirmSubmit]);

  const handleConfirmDecline = useCallback((item: { id: string; shotId: string }) => {
    setChatItems(items => items.map(entry => (
      entry.kind === "confirm" && entry.id === item.id ? { ...entry, status: "declined" } : entry
    )));
    pushBubble("assistant", t("chat.confirmDeclined", { shot: item.shotId }), [], true);
  }, [pushBubble]);

  return {
    chatItems,
    streaming,
    streamingRef,
    setStreaming,
    handleEvent,
    handleEventRef,
    sendMessage,
    pushError,
    pushBubble,
    resetChatFromHistory,
    clearChat,
    handleConfirmSubmit,
    handleConfirmDecline,
  };
}
