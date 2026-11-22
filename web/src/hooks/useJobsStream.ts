import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api } from "../lib/api";
import type { RenderJob } from "../lib/types";

type UseJobsStreamOptions = {
  getProjectId: () => string | null;
  /** Agent 事件从 jobs SSE 复用过来时回调。 */
  onAgentEvent: (event: Record<string, unknown>) => void;
  /** job 进入终态或 agent done 时触发（刷新项目快照）。 */
  onRefresh: () => void;
  streamingRef: { current: boolean };
  setStreaming: (value: boolean) => void;
};

/**
 * 项目渲染队列的 SSE 订阅与断线重连。
 * 切项目时必须 disconnect 旧流，避免旧 projectId 的 job 覆盖面板。
 */
export function useJobsStream({
  getProjectId,
  onAgentEvent,
  onRefresh,
  streamingRef,
  setStreaming,
}: UseJobsStreamOptions) {
  const [jobs, setJobs] = useState<RenderJob[]>([]);
  const jobsSourceRef = useRef<EventSource | null>(null);
  const jobsSourcesRef = useRef<Set<EventSource>>(new Set());
  const jobsRetryRef = useRef(0);
  const jobsRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onAgentEventRef = useRef(onAgentEvent);
  const onRefreshRef = useRef(onRefresh);

  useEffect(() => {
    onAgentEventRef.current = onAgentEvent;
  }, [onAgentEvent]);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  const resyncJobs = useCallback((projectId: string) => {
    api<{ jobs: RenderJob[] }>(`/api/projects/${encodeURIComponent(projectId)}/jobs`)
      .then(data => {
        if (getProjectId() !== projectId) return;
        setJobs(data.jobs || []);
      })
      .catch(() => {});
  }, [getProjectId]);

  const connectJobs = useCallback((projectId: string | null, options: { keepJobs?: boolean } = {}) => {
    for (const stale of jobsSourcesRef.current) stale.close();
    jobsSourcesRef.current.clear();
    jobsSourceRef.current = null;
    clearTimeout(jobsRetryTimerRef.current ?? undefined);
    jobsRetryTimerRef.current = null;
    if (!options.keepJobs) setJobs([]);
    if (!projectId) return;

    const source = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/jobs/stream`);
    jobsSourceRef.current = source;
    jobsSourcesRef.current.add(source);

    source.onopen = () => {
      jobsRetryRef.current = 0;
      // 开流后立刻 REST 对齐：防止 SSE 首包丢失 / 代理缓冲时右侧队列一直空。
      resyncJobs(projectId);
    };

    source.onmessage = event => {
      if (jobsSourceRef.current !== source) return;
      let payload: { type?: string; jobs?: RenderJob[]; job?: RenderJob; event?: Record<string, unknown> };
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (payload.type === "snapshot") {
        setJobs(payload.jobs || []);
        jobsRetryRef.current = 0;
        return;
      }
      if (payload.type === "job" && payload.job) {
        const job = payload.job;
        setJobs(current => {
          const index = current.findIndex(item => item.id === job.id);
          if (index >= 0) {
            const next = current.slice();
            next[index] = job;
            return next;
          }
          return [job, ...current];
        });
        if (job.status === "done" || job.status === "pending" || job.status === "failed") {
          onRefreshRef.current();
        }
        return;
      }
      if (payload.type === "agent" && payload.event) {
        const agentEvent = payload.event as { type?: string };
        if (agentEvent.type === "done") {
          setStreaming(false);
          onRefreshRef.current();
        } else if (agentEvent.type && agentEvent.type !== "ping" && !streamingRef.current) {
          setStreaming(true);
        }
        onAgentEventRef.current(payload.event as Record<string, unknown>);
      }
    };

    source.onerror = () => {
      if (jobsSourceRef.current !== source) return;
      source.close();
      jobsSourcesRef.current.delete(source);
      jobsSourceRef.current = null;
      const attempt = jobsRetryRef.current + 1;
      jobsRetryRef.current = attempt;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt - 1, 5));
      clearTimeout(jobsRetryTimerRef.current ?? undefined);
      jobsRetryTimerRef.current = setTimeout(() => {
        jobsRetryTimerRef.current = null;
        if (getProjectId() === projectId && !jobsSourceRef.current) {
          connectJobs(projectId, { keepJobs: true });
        }
      }, delay);
    };
  }, [getProjectId, resyncJobs, setStreaming, streamingRef]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const id = getProjectId();
      if (id) resyncJobs(id);
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [getProjectId, resyncJobs]);

  const dispose = useCallback(() => {
    for (const source of jobsSourcesRef.current) source.close();
    jobsSourcesRef.current.clear();
    jobsSourceRef.current = null;
    clearTimeout(jobsRetryTimerRef.current ?? undefined);
  }, []);

  return { jobs, setJobs, connectJobs, resyncJobs, dispose };
}
