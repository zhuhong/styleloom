import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "./lib/api";
import { getLang, initLang, setLang, subscribeLang, t } from "./lib/i18n";
import type {
  AppSettings,
  ChatAttachment,
  ChatItem,
  ChatMessage,
  InspectorTab,
  MediaRequest,
  PendingUpload,
  Project,
  ProjectSummary,
  ReferenceShot,
  RenderJob,
  SkillRating,
  SkillSummary,
  ShotSkillFeedback,
  StylePackSummary,
  ToolCardState,
} from "./lib/types";
import { fileUrl, isUploadableFile, mediaTypeForPath, uid } from "./lib/utils";
import { ChatPane } from "./components/ChatPane";
import { Inspector } from "./components/Inspector";
import { MediaDialog } from "./components/MediaDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";

const panelScopedTools = new Set(["generate_shot", "resume_shot"]);

/**
 * 从拖拽载荷里提取图片地址。
 * 从 Finder/照片拖是 files；从浏览器或图片应用拖常常只有 text/uri-list 或一段 <img src> 的 HTML。
 * 是否真的是图片交给服务端按 Content-Type 判断，这里只挑出 http(s) 链接。
 */
function collectImageSources(dataTransfer: DataTransfer) {
  const urls: string[] = [];
  const add = (value: string | null | undefined) => {
    const trimmed = (value ?? "").trim();
    if (/^https?:\/\//i.test(trimmed)) urls.push(trimmed);
  };
  add(dataTransfer.getData("text/uri-list"));
  add(dataTransfer.getData("text/plain"));
  const html = dataTransfer.getData("text/html");
  if (html) {
    for (const match of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) add(match[1]);
  }
  return [...new Set(urls)].slice(0, 6);
}

function engineFlags(settings: AppSettings | null) {
  if (!settings) return [];
  return [
    settings.llm?.model ? "LLM" : null,
    settings.llm?.visionModel ? "VLM" : null,
    settings.video?.provider === "local" ? t("app.engineLocalH3") : settings.video?.apiKey ? "H3" : null,
    settings.image?.model || settings.image?.local?.mode === "direct" || settings.image?.local?.host ? t("app.engineImage") : null,
  ].filter(Boolean) as string[];
}

export function App() {
  const [, setLangTick] = useState(0);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [packs, setPacks] = useState<StylePackSummary[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [shots, setShots] = useState<ReferenceShot[]>([]);
  const [jobs, setJobs] = useState<RenderJob[]>([]);
  const [chatItems, setChatItems] = useState<ChatItem[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [input, setInput] = useState("");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [media, setMedia] = useState<MediaRequest | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab | null>(null);
  const [assetFilter, setAssetFilter] = useState("all");
  const [skillFilter, setSkillFilter] = useState("all");
  const [showAllSkills, setShowAllSkills] = useState(false);
  const [skillFeedbackBusy, setSkillFeedbackBusy] = useState<string | null>(null);
  /** 本会话临时覆盖；持久态来自 project.plan[].skillFeedback / skills[].lastOutcome。 */
  const [skillFeedbackOverrides, setSkillFeedbackOverrides] = useState<Record<string, { rating: SkillRating; count?: number }>>({});
  /** 拖拽到窗口上时显示全屏投放提示。 */
  const [dragActive, setDragActive] = useState(false);

  const projectRef = useRef<Project | null>(null);
  const streamingRef = useRef(false);
  /**
   * 确认卡片占位。用 ref 而不是 state：避免把「按钮刚点过」这种瞬时状态写进依赖数组，
   * 也避免状态的批量更新还没落地时双击就通过了判断。
   */
  const confirmSubmitRef = useRef(false);
  const handleEventRef = useRef<(event: Record<string, unknown>) => void>(() => {});
  const jobsSourceRef = useRef<EventSource | null>(null);
  /** 所有存活的 EventSource。切项目/重连时全关，避免残留连接用旧项目的 job 覆盖面板。 */
  const jobsSourcesRef = useRef<Set<EventSource>>(new Set());
  const jobsRetryRef = useRef(0);
  const jobsRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** dragenter/dragleave 会成对冒泡多次，用计数避免闪烁。 */
  const dragDepthRef = useRef(0);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);

  useEffect(() => {
    initLang();
    return subscribeLang(() => setLangTick(value => value + 1));
  }, []);

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

  const loadProjects = useCallback(async () => {
    const data = await api<{ projects: ProjectSummary[] }>("/api/projects");
    setProjects(data.projects || []);
    return data.projects || [];
  }, []);

  const loadPacks = useCallback(async () => {
    const data = await api<{ packs: StylePackSummary[] }>("/api/library/packs");
    setPacks(data.packs || []);
  }, []);

  const loadSkills = useCallback(async () => {
    const data = await api<{ skills: SkillSummary[] }>("/api/skills");
    setSkills(data.skills || []);
  }, []);

  const skillFeedbackNotes = useMemo(() => {
    const notes: Record<string, { rating: SkillRating; count?: number }> = {};
    for (const shot of project?.plan || []) {
      if (!shot.skillFeedback) continue;
      notes[shot.id] = {
        rating: shot.skillFeedback.rating,
        count: shot.skillFeedback.count,
      };
    }
    for (const skill of skills) {
      if (!skill.lastOutcome) continue;
      notes[skill.id] = { rating: skill.lastOutcome.rating };
    }
    return { ...notes, ...skillFeedbackOverrides };
  }, [project, skills, skillFeedbackOverrides]);

  const handleShotSkillOutcome = useCallback(async (shotId: string, rating: SkillRating) => {
    const current = projectRef.current;
    if (!current) return;
    setSkillFeedbackBusy(shotId);
    try {
      const result = await api<{ skills?: SkillSummary[]; skillFeedback?: ShotSkillFeedback }>(`/api/projects/${encodeURIComponent(current.id)}/shots/${encodeURIComponent(shotId)}/skill-outcomes`, {
        method: "POST",
        body: JSON.stringify({ rating }),
      });
      const feedback = result.skillFeedback ?? {
        rating,
        at: new Date().toISOString(),
        count: result.skills?.length ?? 0,
      };
      setSkillFeedbackOverrides(notes => ({ ...notes, [shotId]: { rating: feedback.rating, count: feedback.count } }));
      setProject(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          plan: (prev.plan || []).map(shot => shot.id === shotId ? { ...shot, skillFeedback: feedback } : shot),
        };
      });
      await loadSkills();
    } catch (error) {
      pushError(error instanceof Error ? error.message : String(error));
    } finally {
      setSkillFeedbackBusy(null);
    }
  }, [loadSkills, pushError]);

  const handleSkillOutcome = useCallback(async (skillId: string, rating: SkillRating) => {
    const current = projectRef.current;
    if (!current) {
      pushError(t("skills.needProject"));
      return;
    }
    setSkillFeedbackBusy(skillId);
    try {
      await api(`/api/skills/${encodeURIComponent(skillId)}/outcome`, {
        method: "POST",
        body: JSON.stringify({ rating, projectId: current.id }),
      });
      setSkillFeedbackOverrides(notes => ({ ...notes, [skillId]: { rating } }));
      await loadSkills();
    } catch (error) {
      pushError(error instanceof Error ? error.message : String(error));
    } finally {
      setSkillFeedbackBusy(null);
    }
  }, [loadSkills, pushError]);

  const loadSettings = useCallback(async () => {
    const data = await api<AppSettings>("/api/settings");
    setSettings(data);
    return data;
  }, []);

  const refreshDetail = useCallback(async () => {
    const current = projectRef.current;
    if (!current) return;
    const data = await api<{ project: Project; shots: ReferenceShot[] }>(`/api/projects/${encodeURIComponent(current.id)}`);
    setProject(data.project);
    setShots(data.shots || []);
    await loadProjects();
  }, [loadProjects]);

  const scheduleRefresh = useCallback(() => {
    clearTimeout(refreshTimerRef.current ?? undefined);
    refreshTimerRef.current = setTimeout(() => {
      refreshDetail().catch(error => console.warn(error));
      loadPacks().catch(() => {});
      loadSkills().catch(() => {});
    }, 400);
  }, [loadPacks, loadSkills, refreshDetail]);

  const resyncJobs = useCallback((projectId: string) => {
    // SSE 断了、或者某一拍 job 事件丢了，靠一次 REST 快照对齐；比等下次广播可靠。
    api<{ jobs: RenderJob[] }>(`/api/projects/${encodeURIComponent(projectId)}/jobs`)
      .then(data => {
        if (projectRef.current?.id !== projectId) return;
        setJobs(data.jobs || []);
      })
      .catch(() => {});
  }, []);

  const connectJobs = useCallback((projectId: string | null, options: { keepJobs?: boolean } = {}) => {
    // 关闭所有旧连接，不只是 ref 里那个。
    // 否则 onerror 重连与切项目并发时会有两条流并存，旧流继续推别的项目的 job。
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
      if (options.keepJobs) resyncJobs(projectId);
    };

    source.onmessage = event => {
      // 已不是当前连接 → 丢弃。防止旧项目的流继续改写面板。
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
          scheduleRefresh();
        }
        return;
      }
      // 渲染完成唤醒：服务端把 Agent 事件复用到 jobs SSE，对话能第一时间看到。
      if (payload.type === "agent" && payload.event) {
        const agentEvent = payload.event as { type?: string };
        if (agentEvent.type === "done") {
          setStreaming(false);
          scheduleRefresh();
        } else if (agentEvent.type && agentEvent.type !== "ping" && !streamingRef.current) {
          setStreaming(true);
        }
        handleEventRef.current(payload.event as Record<string, unknown>);
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
        if (projectRef.current?.id === projectId && !jobsSourceRef.current) {
          connectJobs(projectId, { keepJobs: true });
        }
      }, delay);
    };
  }, [resyncJobs, scheduleRefresh]);

  // 回到标签页 / 重新聚焦时对齐一次渲染队列：长时间挂着的页面即使 SSE 悄悄断了，
  // 也不会永远停在旧的（可能是空的）列表上。
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const id = projectRef.current?.id;
      if (id) resyncJobs(id);
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [resyncJobs]);

  const clearPendingUploads = useCallback(() => {
    setPendingUploads(current => {
      for (const entry of current) {
        if (entry.previewUrl.startsWith("blob:")) URL.revokeObjectURL(entry.previewUrl);
      }
      return [];
    });
    setUploading(0);
  }, []);

  const selectProject = useCallback(async (id: string) => {
    setMedia(null);
    clearPendingUploads();
    setInspectorTab(null);
    setAssetFilter("all");
    setSkillFilter("all");
    setShowAllSkills(false);
    setSkillFeedbackBusy(null);
    setSkillFeedbackOverrides({});
    try {
      const data = await api<{ project: Project; shots: ReferenceShot[]; messages: ChatMessage[] }>(
        `/api/projects/${encodeURIComponent(id)}`,
      );
      setProject(data.project);
      setShots(data.shots || []);
      setChatItems((data.messages || []).map(message => ({
        kind: "bubble" as const,
        id: uid("hist"),
        role: message.role,
        content: message.content,
        attachments: message.attachments || [],
      })));
      connectJobs(id);
    } catch (error) {
      pushError(t("errors.openProject", { message: (error as Error).message }));
    }
  }, [clearPendingUploads, connectJobs, pushError]);

  useEffect(() => {
    (async () => {
      try {
        await Promise.all([loadSettings(), loadPacks(), loadSkills()]);
        const list = await loadProjects();
        if (list.length) await selectProject(list[0].id);
      } catch (error) {
        pushError(t("errors.init", { message: (error as Error).message }));
      }
    })();
    return () => {
      for (const source of jobsSourcesRef.current) source.close();
      jobsSourcesRef.current.clear();
      jobsSourceRef.current = null;
      clearTimeout(jobsRetryTimerRef.current ?? undefined);
      clearTimeout(refreshTimerRef.current ?? undefined);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleEvent = useCallback((event: Record<string, unknown>) => {
    if (event.type === "message") {
      if (event.role === "user") return;
      pushBubble("assistant", String(event.content ?? ""), (event.attachments as ChatAttachment[]) || []);
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
        if (projectRef.current?.id === deletedId) {
          clearPendingUploads();
          setMedia(null);
          setInspectorTab(null);
          setAssetFilter("all");
          setSkillFilter("all");
          setShowAllSkills(false);
          if (list.length) await selectProject(list[0].id);
          else {
            setProject(null);
            setShots([]);
            setChatItems([]);
            setJobs([]);
            connectJobs(null);
          }
        }
      }).catch(error => pushError(t("errors.deleteProject", { message: (error as Error).message })));
      return;
    }
    if (event.type === "error") {
      pushError(t("errors.generic", { message: String(event.message ?? "") }));
    }
  }, [clearPendingUploads, connectJobs, loadProjects, pushBubble, pushError, scheduleRefresh, selectProject]);

  useEffect(() => {
    handleEventRef.current = handleEvent;
  }, [handleEvent]);

  const sendMessage = useCallback(async (message: string, attachments: ChatAttachment[] = []) => {
    const current = projectRef.current;
    if (!current) {
      pushError(t("errors.needProject"));
      return;
    }
    setStreaming(true);
    // 确认卡片代发的消息不进气泡（与历史回放口径一致：以 [确认卡片] 开头的用户消息对前端隐藏）。
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
      // 一轮对话可能刚提交了渲染，这时候立即拉一次队列，不依赖 jobs SSE 那一拍。
      resyncJobs(current.id);
    }
  }, [handleEvent, pushBubble, pushError, resyncJobs, scheduleRefresh]);

  const uploadFiles = useCallback(async (fileList: FileList | File[]) => {
    const current = projectRef.current;
    if (!current) {
      pushError(t("errors.needProjectForUpload"));
      return;
    }
    const files = [...fileList].filter(isUploadableFile);
    if (!files.length) {
      pushError(t("errors.onlyMedia"));
      return;
    }
    let blocked = false;
    setPendingUploads(currentUploads => {
      if (currentUploads.length + files.length > 6) {
        blocked = true;
        return currentUploads;
      }
      return currentUploads;
    });
    if (blocked) {
      pushError(t("errors.tooManyUploads", { max: 6 }));
      return;
    }

    const entries: PendingUpload[] = files.map(file => ({
      file,
      kind: file.type.startsWith("video/") || /\.(mp4|mov|webm|m4v)$/i.test(file.name) ? "video" : "image",
      previewUrl: URL.createObjectURL(file),
      status: "uploading",
    }));
    setPendingUploads(currentUploads => [...currentUploads, ...entries]);
    setUploading(value => value + entries.length);

    const form = new FormData();
    for (const [index, entry] of entries.entries()) {
      const file = files[index];
      if (file) form.append("files", file, file.name);
    }
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(current.id)}/uploads`, { method: "POST", body: form });
      const data = await response.json().catch(() => ({})) as { assets?: Project["assets"]; error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const assets = Array.isArray(data.assets) ? data.assets : [];
      setPendingUploads(currentUploads => currentUploads.map(entry => {
        const index = entries.indexOf(entry);
        if (index < 0) return entry;
        const asset = assets[index];
        if (!asset) return { ...entry, status: "error", error: t("errors.noAssetReturned") };
        if (entry.previewUrl.startsWith("blob:")) URL.revokeObjectURL(entry.previewUrl);
        return {
          ...entry,
          asset,
          kind: mediaTypeForPath(asset.path) === "video" ? "video" : "image",
          mimeType: typeof asset.meta?.mimeType === "string" ? asset.meta.mimeType : undefined,
          size: typeof asset.meta?.size === "number" ? asset.meta.size : undefined,
          status: "done",
          previewUrl: fileUrl(current.id, asset.path),
        };
      }));
      scheduleRefresh();
    } catch (error) {
      setPendingUploads(currentUploads => currentUploads.map(entry => (
        entries.includes(entry) ? { ...entry, status: "error", error: (error as Error).message } : entry
      )));
      pushError(t("errors.uploadFailed", { message: (error as Error).message }));
    } finally {
      setUploading(value => Math.max(0, value - entries.length));
    }
  }, [pushError, scheduleRefresh]);

  /**
   * 从 URL 上传（拖拽图片链接 / 从图片应用拖出来的 HTML）。
   * 交给服务端下载：浏览器直连第三方图床会被 CORS 挡住，服务端还会做 SSRF 与大小校验。
   */
  const uploadUrls = useCallback(async (urls: string[]) => {
    const current = projectRef.current;
    if (!current) {
      pushError(t("errors.needProjectForUpload"));
      return;
    }
    const unique = [...new Set(urls.map(url => url.trim()).filter(Boolean))];
    if (!unique.length) return;
    let blocked = false;
    setPendingUploads(currentUploads => {
      if (currentUploads.length + unique.length > 6) blocked = true;
      return currentUploads;
    });
    if (blocked) {
      pushError(t("errors.tooManyUploads", { max: 6 }));
      return;
    }

    const entries: PendingUpload[] = unique.map(url => ({
      kind: "image",
      previewUrl: "",
      status: "uploading",
      sourceUrl: url,
    }));
    setPendingUploads(currentUploads => [...currentUploads, ...entries]);
    setUploading(value => value + entries.length);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(current.id)}/uploads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: unique }),
      });
      const data = await response.json().catch(() => ({})) as { assets?: Project["assets"]; errors?: string[]; error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const assets = Array.isArray(data.assets) ? data.assets : [];
      const failures = Array.isArray(data.errors) ? data.errors : [];
      setPendingUploads(currentUploads => currentUploads.map(entry => {
        const index = entries.indexOf(entry);
        if (index < 0) return entry;
        const asset = assets[index];
        if (!asset) {
          return { ...entry, status: "error", error: failures[0] || t("errors.noAssetReturned") };
        }
        return {
          ...entry,
          asset,
          kind: mediaTypeForPath(asset.path) === "video" ? "video" : "image",
          mimeType: typeof asset.meta?.mimeType === "string" ? asset.meta.mimeType : undefined,
          size: typeof asset.meta?.size === "number" ? asset.meta.size : undefined,
          status: "done",
          previewUrl: fileUrl(current.id, asset.path),
        };
      }));
      scheduleRefresh();
    } catch (error) {
      setPendingUploads(currentUploads => currentUploads.map(entry => (
        entries.includes(entry) ? { ...entry, status: "error", error: (error as Error).message } : entry
      )));
      pushError(t("errors.uploadFailed", { message: (error as Error).message }));
    } finally {
      setUploading(value => Math.max(0, value - entries.length));
    }
  }, [pushError, scheduleRefresh]);

  /**
   * 统一的拖拽/粘贴入口：先看有没有真实文件，再看链接。
   * 从 Finder / 照片拖出来是 files；从别的浏览器或图片应用拖出来常常只有
   * text/uri-list 或一段 <img src="..."> 的 HTML，两个都要认。
   */
  const handleDropTransfer = useCallback((dataTransfer: DataTransfer | null) => {
    if (!dataTransfer) return;
    const files = [...(dataTransfer.files ?? [])].filter(isUploadableFile);
    if (files.length) {
      void uploadFiles(files);
      return;
    }
    const urls = collectImageSources(dataTransfer);
    if (urls.length) {
      void uploadUrls(urls);
      return;
    }
    pushError(t("errors.unsupportedDrop"));
  }, [pushError, uploadFiles, uploadUrls]);

  /**
   * 全窗口拖拽投放：从其它应用拖图片进来就能用，不必对准输入框。
   * 必须阻止 dragover 的默认行为，否则浏览器会直接用拖进来的图片替换当前页面。
   */
  useEffect(() => {
    const onDragEnter = (event: DragEvent) => {
      if (!event.dataTransfer) return;
      dragDepthRef.current += 1;
      if (!projectRef.current) return;
      event.preventDefault();
      setDragActive(true);
    };
    const onDragOver = (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = projectRef.current ? "copy" : "none";
    };
    const onDragLeave = () => {
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (!dragDepthRef.current) setDragActive(false);
    };
    const onDrop = (event: DragEvent) => {
      // 必须先读：preventDefault 之后 defaultPrevented 一定为 true，会把兜底逻辑吞掉。
      const handledByChild = event.defaultPrevented;
      event.preventDefault();
      dragDepthRef.current = 0;
      setDragActive(false);
      // 输入框那层已经处理并 stopPropagation 过，这里只兜住「扔到页面其它地方」
      if (handledByChild) return;
      handleDropTransfer(event.dataTransfer);
    };
    const onPaste = (event: ClipboardEvent) => {
      // 从截图工具/图片应用直接 Cmd+V 也当上传处理；纯文本粘贴不受影响
      const files = [...(event.clipboardData?.files ?? [])].filter(isUploadableFile);
      if (!files.length) return;
      event.preventDefault();
      void uploadFiles(files);
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    document.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      document.removeEventListener("paste", onPaste);
    };
  }, [handleDropTransfer, uploadFiles]);

  const handleSend = useCallback((message: string, attachments: ChatAttachment[]) => {
    setInput("");
    clearPendingUploads();
    void sendMessage(message, attachments);
  }, [clearPendingUploads, sendMessage]);

  /** 确认卡片的提交占位：同一时刻只允许一个提交在飞，避免双击触发两次计费。 */
  const tryStartConfirmSubmit = useCallback(() => {
    if (confirmSubmitRef.current || streamingRef.current) return false;
    confirmSubmitRef.current = true;
    return true;
  }, []);

  /**
   * 确认卡片：点「提交」时用一条隐藏的用户消息唤醒 Agent 真正调用 generate_shot(confirmed=true)。
   * 消息以 [确认卡片] 开头，历史回放时会被 server.ts:historyMessages 过滤掉。
   */
  const handleConfirmSubmit = useCallback((item: { id: string; shotId: string; title: string; durationSeconds?: number; force?: boolean }) => {
    // 双击/并发保护：确认卡片提交是计费入口，必须先占位成功再发消息。
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

  const handleNewProject = useCallback(async () => {
    const title = window.prompt(t("misc.newProjectPromptTitle"), t("misc.newProjectDefaultTitle"));
    if (title === null) return;
    try {
      const data = await api<{ project: Project }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ title }),
      });
      await loadProjects();
      await selectProject(data.project.id);
    } catch (error) {
      pushError(t("errors.createProject", { message: (error as Error).message }));
    }
  }, [loadProjects, pushError, selectProject]);

  const clearWorkspace = useCallback(() => {
    setMedia(null);
    clearPendingUploads();
    setInspectorTab(null);
    setAssetFilter("all");
    setSkillFilter("all");
    setShowAllSkills(false);
    setProject(null);
    setShots([]);
    setChatItems([]);
    setJobs([]);
    connectJobs(null);
  }, [clearPendingUploads, connectJobs]);

  const handleRenameProject = useCallback(async (id: string, currentTitle: string) => {
    const title = window.prompt(t("nav.renamePromptTitle"), currentTitle);
    if (title === null) return;
    const nextTitle = title.trim();
    if (!nextTitle || nextTitle === currentTitle) return;
    try {
      const data = await api<{ project: Project }>(`/api/projects/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ title: nextTitle }),
      });
      await loadProjects();
      if (projectRef.current?.id === id) {
        setProject(current => (current ? { ...current, title: data.project.title, updatedAt: data.project.updatedAt } : current));
      }
    } catch (error) {
      pushError(t("errors.renameProject", { message: (error as Error).message }));
    }
  }, [loadProjects, pushError]);

  const handleDeleteProject = useCallback(async (id: string, title: string) => {
    if (!window.confirm(t("nav.deleteConfirm", { title }))) return;
    const wasCurrent = projectRef.current?.id === id;
    try {
      await api(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
      const list = await loadProjects();
      if (wasCurrent) {
        if (list.length) await selectProject(list[0].id);
        else clearWorkspace();
      }
    } catch (error) {
      pushError(t("errors.deleteProject", { message: (error as Error).message }));
    }
  }, [clearWorkspace, loadProjects, pushError, selectProject]);

  const handleResumeShot = useCallback(async (shotId: string) => {
    const current = projectRef.current;
    if (!current || !shotId) return;
    try {
      const result = await api<{ job: RenderJob }>(`/api/projects/${encodeURIComponent(current.id)}/jobs`, {
        method: "POST",
        body: JSON.stringify({ shotId, action: "resume" }),
      });
      if (result?.job) {
        setJobs(currentJobs => {
          const index = currentJobs.findIndex(item => item.id === result.job.id);
          if (index >= 0) {
            const next = currentJobs.slice();
            next[index] = result.job;
            return next;
          }
          return [result.job, ...currentJobs];
        });
      }
    } catch (error) {
      pushError(t("errors.resumeFailed", { message: (error as Error).message }));
    }
  }, [pushError]);

  const handleSaveSettings = useCallback(async (next: AppSettings) => {
    const saved = await api<AppSettings>("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ settings: next }),
    });
    setSettings(saved);
    setSettingsOpen(false);
  }, []);

  const openSettings = useCallback(async () => {
    try {
      await loadSettings();
      setSettingsOpen(true);
    } catch (error) {
      pushError(t("errors.loadSettings", { message: (error as Error).message }));
    }
  }, [loadSettings, pushError]);

  const flags = engineFlags(settings);
  const lang = getLang();

  return (
    <>
      <header class="topbar">
        <div class="brand">
          <span class="brandMark" />
          <div>
            <strong>StyleLoom</strong>
            <small>{t("app.tagline")}</small>
          </div>
        </div>
        <div class="topActions">
          <span class={`engineState ${flags.length >= 3 ? "ok" : "warn"}`}>
            {settings
              ? (flags.length ? t("app.engineConfigured", { flags: flags.join(" · ") }) : t("app.engineNotConfigured"))
              : t("app.engineChecking")}
          </span>
          <div class="langSwitch" role="group" aria-label="语言 / Language" title="语言 / Language">
            <button type="button" data-lang="zh" aria-pressed={lang === "zh"} class={lang === "zh" ? "active" : ""} onClick={() => setLang("zh")}>中</button>
            <button type="button" data-lang="en" aria-pressed={lang === "en"} class={lang === "en" ? "active" : ""} onClick={() => setLang("en")}>EN</button>
          </div>
          <button type="button" class="ghost" onClick={() => void openSettings()}>{t("settings.title")}</button>
        </div>
      </header>

      <main class="layout">
        <aside class="sidebar">
          <Sidebar
            projects={projects}
            packs={packs}
            currentProjectId={project?.id ?? null}
            onSelectProject={id => void selectProject(id)}
            onNewProject={() => void handleNewProject()}
            onRenameProject={(id, title) => void handleRenameProject(id, title)}
            onDeleteProject={(id, title) => void handleDeleteProject(id, title)}
          />
        </aside>

        <ChatPane
          projectId={project?.id ?? null}
          items={chatItems}
          streaming={streaming}
          uploading={uploading}
          pendingUploads={pendingUploads}
          input={input}
          onInputChange={setInput}
          onSend={handleSend}
          onRemoveUpload={index => {
            setPendingUploads(current => {
              const next = current.slice();
              const [entry] = next.splice(index, 1);
              if (entry?.previewUrl.startsWith("blob:")) URL.revokeObjectURL(entry.previewUrl);
              return next;
            });
          }}
          onOpenMedia={setMedia}
          onFilesDropped={files => void uploadFiles(files)}
          onDropTransfer={handleDropTransfer}
          onConfirmSubmit={handleConfirmSubmit}
          onConfirmDecline={handleConfirmDecline}
        />

        <Inspector
          project={project}
          shots={shots}
          skills={skills}
          jobs={jobs}
          inspectorTab={inspectorTab}
          assetFilter={assetFilter}
          skillFilter={skillFilter}
          showAllSkills={showAllSkills}
          onTabChange={setInspectorTab}
          onAssetFilter={setAssetFilter}
          onSkillFilter={filter => {
            setSkillFilter(filter);
            setShowAllSkills(false);
          }}
          onToggleShowAllSkills={() => setShowAllSkills(value => !value)}
          onOpenMedia={setMedia}
          onResumeShot={shotId => void handleResumeShot(shotId)}
          onShotSkillOutcome={(shotId, rating) => void handleShotSkillOutcome(shotId, rating)}
          onSkillOutcome={(skillId, rating) => void handleSkillOutcome(skillId, rating)}
          skillFeedbackBusy={skillFeedbackBusy}
          skillFeedbackNotes={skillFeedbackNotes}
        />
      </main>

      {dragActive && project ? (
        <div class="dropOverlay" aria-hidden="true">
          <div class="dropCard">
            <b>{t("drop.title")}</b>
            <span>{t("drop.hint")}</span>
          </div>
        </div>
      ) : null}

      <MediaDialog media={media} onClose={() => setMedia(null)} />
      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSave={async next => {
          try {
            await handleSaveSettings(next);
          } catch (error) {
            pushError(t("errors.saveSettings", { message: (error as Error).message }));
            throw error;
          }
        }}
      />
    </>
  );
}
