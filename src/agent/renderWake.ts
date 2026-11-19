import type { AgentEvent } from "../types";
import type { RenderJob } from "../generate/jobs";
import { broadcastProjectAgentEvent } from "../generate/jobs";
import { readSession, writeSession } from "../store/projects";
import type { LlmMessage } from "../providers/llm";
import { runAgentTurn } from "./loop";
import { endAgentTurn, isAgentTurnActive, tryBeginAgentTurn } from "./turnLock";

const wakeQueues = new Map<string, RenderJob[]>();
const draining = new Set<string>();

function noticeText(job: RenderJob) {
  if (job.status === "done") {
    return job.video
      ? `[后台渲染] 镜头 ${job.shotId} 已生成完成：${job.video}`
      : `[后台渲染] 镜头 ${job.shotId} 已生成完成。`;
  }
  if (job.status === "pending") {
    return `[后台渲染] 镜头 ${job.shotId} 已提交到平台但仍在排队/处理（video_id=${job.videoId ?? "未知"}）。本地不再等待；可用 resume_shot 接回，不要重新 generate_shot。`;
  }
  return `[后台渲染] 镜头 ${job.shotId} 生成失败：${job.error || job.label || "未知错误"}`;
}

function wakeUserMessage(job: RenderJob) {
  if (job.status === "done") {
    return `[系统通知] 后台渲染完成：shotId=${job.shotId}，status=done${job.video ? `，video=${job.video}` : ""}${job.videoId ? `，videoId=${job.videoId}` : ""}。对话里已插入完成通知。请立刻用一两句话告知用户，并询问镜头效果（可提醒右侧分镜/技能面板点好/一般/差）；若用户先前要求成片且其余镜头也已 done，再提议 stitch_shots。不要重新 generate_shot，不要轮询，不要重复粘贴长路径。`;
  }
  if (job.status === "pending") {
    return `[系统通知] 后台渲染本地放弃等待：shotId=${job.shotId}，status=pending，videoId=${job.videoId ?? "未知"}。请告知用户任务可能仍在平台排队，建议 resume_shot；禁止未确认就重新 generate_shot。`;
  }
  return `[系统通知] 后台渲染失败：shotId=${job.shotId}，error=${job.error || job.label || "未知错误"}。请用简短中文说明失败原因与可恢复路径（resume_shot / 查 jobs）；不要立刻重新计费生成。`;
}

async function appendAssistantNotice(projectId: string, content: string) {
  const messages = await readSession<LlmMessage>(projectId);
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && last.content === content) return;
  messages.push({ role: "assistant", content });
  await writeSession(projectId, messages);
}

function enqueueJob(job: RenderJob) {
  const queue = wakeQueues.get(job.projectId) ?? [];
  const index = queue.findIndex(item => item.shotId === job.shotId);
  if (index >= 0) queue[index] = job;
  else queue.push(job);
  wakeQueues.set(job.projectId, queue);
}

async function drainWakeQueue(projectId: string) {
  if (draining.has(projectId)) return;
  draining.add(projectId);
  try {
    while (true) {
      const queue = wakeQueues.get(projectId) ?? [];
      if (!queue.length) break;
      if (isAgentTurnActive(projectId)) break;
      if (!tryBeginAgentTurn(projectId)) break;
      const job = queue.shift()!;
      wakeQueues.set(projectId, queue);
      const abort = new AbortController();
      try {
        await runAgentTurn(
          projectId,
          wakeUserMessage(job),
          (event: AgentEvent) => broadcastProjectAgentEvent(projectId, event),
          abort.signal,
        );
      } catch (error) {
        broadcastProjectAgentEvent(projectId, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        endAgentTurn(projectId);
        broadcastProjectAgentEvent(projectId, { type: "done" });
      }
    }
  } finally {
    draining.delete(projectId);
    if ((wakeQueues.get(projectId) ?? []).length && !isAgentTurnActive(projectId)) {
      void drainWakeQueue(projectId);
    }
  }
}

/** 渲染进入终态后：立刻在对话里可见通知，并在空闲时唤醒 Agent 做后续交代。 */
export async function notifyRenderJobTerminal(job: RenderJob) {
  if (job.status !== "done" && job.status !== "failed" && job.status !== "pending") return;
  const content = noticeText(job);
  const attachments = job.status === "done" && job.video
    ? [{ path: job.video, label: `${job.shotId} 成片`, kind: "video" as const }]
    : undefined;
  broadcastProjectAgentEvent(job.projectId, { type: "message", role: "assistant", content, attachments });
  await appendAssistantNotice(job.projectId, content).catch(() => undefined);
  enqueueJob(job);
  void drainWakeQueue(job.projectId);
}

/** 用户对话结束后再冲一次队列，避免渲染完成撞上忙碌轮次后一直挂起。 */
export function flushRenderWakeQueue(projectId: string) {
  void drainWakeQueue(projectId);
}
