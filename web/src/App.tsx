import { useCallback, useEffect, useRef, useState } from "preact/hooks";
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
  SkillSummary,
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

  const projectRef = useRef<Project | null>(null);
  const jobsSourceRef = useRef<EventSource | null>(null);
  const jobsRetryRef = useRef(0);
  const jobsRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

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

  const connectJobs = useCallback((projectId: string | null, options: { keepJobs?: boolean } = {}) => {
    if (jobsSourceRef.current) {
      jobsSourceRef.current.close();
      jobsSourceRef.current = null;
    }
    clearTimeout(jobsRetryTimerRef.current ?? undefined);
    jobsRetryTimerRef.current = null;
    if (!options.keepJobs) setJobs([]);
    if (!projectId) return;

    const source = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/jobs/stream`);
    jobsSourceRef.current = source;

    source.onopen = () => {
      jobsRetryRef.current = 0;
      if (options.keepJobs) {
        api<{ jobs: RenderJob[] }>(`/api/projects/${encodeURIComponent(projectId)}/jobs`)
          .then(data => {
            if (projectRef.current?.id !== projectId) return;
            setJobs(data.jobs || []);
          })
          .catch(() => {});
      }
    };

    source.onmessage = event => {
      let payload: { type?: string; jobs?: RenderJob[]; job?: RenderJob };
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
      }
    };

    source.onerror = () => {
      if (jobsSourceRef.current !== source) return;
      source.close();
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
  }, [scheduleRefresh]);

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
      jobsSourceRef.current?.close();
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
    if (event.type === "error") {
      pushError(t("errors.generic", { message: String(event.message ?? "") }));
    }
  }, [pushBubble, pushError, scheduleRefresh]);

  const sendMessage = useCallback(async (message: string, attachments: ChatAttachment[] = []) => {
    const current = projectRef.current;
    if (!current) {
      pushError(t("errors.needProject"));
      return;
    }
    setStreaming(true);
    pushBubble("user", message, attachments);
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
    }
  }, [handleEvent, pushBubble, pushError, scheduleRefresh]);

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
    for (const entry of entries) form.append("files", entry.file, entry.file.name);
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

  const handleSend = useCallback((message: string, attachments: ChatAttachment[]) => {
    setInput("");
    clearPendingUploads();
    void sendMessage(message, attachments);
  }, [clearPendingUploads, sendMessage]);

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
        />
      </main>

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
