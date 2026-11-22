import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "./lib/api";
import { getLang, initLang, setLang, subscribeLang, t } from "./lib/i18n";
import type {
  AppSettings,
  ChatAttachment,
  InspectorTab,
  MediaRequest,
  Project,
  ProjectSummary,
  ReferenceShot,
  RenderJob,
  SkillRating,
  SkillSummary,
  ShotSkillFeedback,
  StylePackSummary,
} from "./lib/types";
import { ChatPane } from "./components/ChatPane";
import { Inspector } from "./components/Inspector";
import { MediaDialog } from "./components/MediaDialog";
import { ConfirmDialog, type ConfirmRequest } from "./components/ConfirmDialog";
import { PromptDialog, type PromptRequest } from "./components/PromptDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { useAgentChat } from "./hooks/useAgentChat";
import { useJobsStream } from "./hooks/useJobsStream";
import { useUploads } from "./hooks/useUploads";

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
  /** 窄屏下 Inspector / Sidebar 以抽屉形式打开。 */
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(false);
  const [sidebarDrawerOpen, setSidebarDrawerOpen] = useState(false);
  const [promptRequest, setPromptRequest] = useState<PromptRequest | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);

  const projectRef = useRef<Project | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectProjectRef = useRef<(id: string) => Promise<void>>(async () => {});
  const clearWorkspaceRef = useRef<() => void>(() => {});

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  useEffect(() => {
    initLang();
    return subscribeLang(() => setLangTick(value => value + 1));
  }, []);

  const getProject = useCallback(() => projectRef.current, []);
  const getProjectId = useCallback(() => projectRef.current?.id ?? null, []);

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

  const resetInspectorUi = useCallback(() => {
    setMedia(null);
    setInspectorTab(null);
    setAssetFilter("all");
    setSkillFilter("all");
    setShowAllSkills(false);
    setSkillFeedbackBusy(null);
    setSkillFeedbackOverrides({});
  }, []);

  const resyncJobsRef = useRef<(projectId: string) => void>(() => {});
  const clearPendingUploadsRef = useRef<() => void>(() => {});
  const handleEventRefBridge = useRef<(event: Record<string, unknown>) => void>(() => {});

  const {
    chatItems,
    streaming,
    streamingRef,
    setStreaming,
    handleEventRef,
    sendMessage,
    pushError,
    resetChatFromHistory,
    clearChat,
    handleConfirmSubmit,
    handleConfirmDecline,
  } = useAgentChat({
    getProject,
    resyncJobs: projectId => resyncJobsRef.current(projectId),
    scheduleRefresh,
    loadProjects,
    selectProject: id => selectProjectRef.current(id),
    clearWorkspace: () => clearWorkspaceRef.current(),
    clearPendingUploads: () => clearPendingUploadsRef.current(),
    setProject,
    resetInspectorUi,
  });

  useEffect(() => {
    handleEventRefBridge.current = event => handleEventRef.current(event);
  }, [handleEventRef]);

  const { jobs, setJobs, connectJobs, resyncJobs, dispose: disposeJobs } = useJobsStream({
    getProjectId,
    onAgentEvent: event => handleEventRefBridge.current(event),
    onRefresh: scheduleRefresh,
    streamingRef,
    setStreaming,
  });

  useEffect(() => {
    resyncJobsRef.current = resyncJobs;
  }, [resyncJobs]);

  const {
    uploading,
    pendingUploads,
    dragActive,
    uploadFiles,
    handleDropTransfer,
    clearPendingUploads,
    removeUpload,
  } = useUploads({
    getProjectId,
    onError: pushError,
    onUploaded: scheduleRefresh,
  });

  useEffect(() => {
    clearPendingUploadsRef.current = clearPendingUploads;
  }, [clearPendingUploads]);

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

  const selectProject = useCallback(async (id: string) => {
    setMedia(null);
    clearPendingUploads();
    setInspectorTab(null);
    setAssetFilter("all");
    setSkillFilter("all");
    setShowAllSkills(false);
    setSkillFeedbackBusy(null);
    setSkillFeedbackOverrides({});
    setSidebarDrawerOpen(false);
    try {
      const data = await api<{ project: Project; shots: ReferenceShot[]; messages: import("./lib/types").ChatMessage[] }>(
        `/api/projects/${encodeURIComponent(id)}`,
      );
      setProject(data.project);
      setShots(data.shots || []);
      resetChatFromHistory(data.messages || []);
      connectJobs(id);
      // EventSource 之外再拉一次 REST，避免首包/重连空隙里右侧渲染队列空白。
      resyncJobs(id);
    } catch (error) {
      pushError(t("errors.openProject", { message: (error as Error).message }));
    }
  }, [clearPendingUploads, connectJobs, pushError, resetChatFromHistory, resyncJobs]);

  const clearWorkspace = useCallback(() => {
    setMedia(null);
    clearPendingUploads();
    setInspectorTab(null);
    setAssetFilter("all");
    setSkillFilter("all");
    setShowAllSkills(false);
    setProject(null);
    setShots([]);
    clearChat();
    connectJobs(null);
  }, [clearChat, clearPendingUploads, connectJobs]);

  useEffect(() => {
    selectProjectRef.current = selectProject;
    clearWorkspaceRef.current = clearWorkspace;
  }, [selectProject, clearWorkspace]);

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
      disposeJobs();
      clearTimeout(refreshTimerRef.current ?? undefined);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!inspectorDrawerOpen && !sidebarDrawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setInspectorDrawerOpen(false);
      setSidebarDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inspectorDrawerOpen, sidebarDrawerOpen]);

  const prevRunningJobsRef = useRef(0);
  useEffect(() => {
    const running = jobs.filter(job => job.status === "running" || job.status === "pending").length;
    // 从「无进行中」变为「有进行中」时切到渲染 Tab，避免提交后还停在分镜页以为没任务。
    if (running > 0 && prevRunningJobsRef.current === 0) {
      setInspectorTab("jobs");
      setInspectorDrawerOpen(true);
    }
    prevRunningJobsRef.current = running;
  }, [jobs]);

  const handleSend = useCallback((message: string, attachments: ChatAttachment[]) => {
    setInput("");
    clearPendingUploads();
    void sendMessage(message, attachments);
  }, [clearPendingUploads, sendMessage]);

  const handleNewProject = useCallback(() => {
    setPromptRequest({
      title: t("misc.newProjectPromptTitle"),
      initialValue: t("misc.newProjectDefaultTitle"),
      confirmLabel: t("misc.createProject"),
      onConfirm: async title => {
        try {
          const data = await api<{ project: Project }>("/api/projects", {
            method: "POST",
            body: JSON.stringify({ title }),
          });
          await loadProjects();
          await selectProject(data.project.id);
        } catch (error) {
          pushError(t("errors.createProject", { message: (error as Error).message }));
          throw error;
        }
      },
    });
  }, [loadProjects, pushError, selectProject]);

  const handleRenameProject = useCallback((id: string, currentTitle: string) => {
    setPromptRequest({
      title: t("misc.renameProjectTitle"),
      initialValue: currentTitle,
      confirmLabel: t("misc.renameProject"),
      onConfirm: async nextTitle => {
        if (nextTitle === currentTitle) return;
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
          throw error;
        }
      },
    });
  }, [loadProjects, pushError]);

  const handleDeleteProject = useCallback((id: string, title: string) => {
    setConfirmRequest({
      title: t("nav.deleteProject"),
      message: t("nav.deleteConfirm", { title }),
      confirmLabel: t("nav.deleteProject"),
      danger: true,
      onConfirm: async () => {
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
          throw error;
        }
      },
    });
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
  }, [pushError, setJobs]);

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
  const drawerOpen = inspectorDrawerOpen || sidebarDrawerOpen;

  return (
    <>
      <header class="topbar">
        <div class="brand">
          <button
            type="button"
            class="navToggle ghost"
            aria-expanded={sidebarDrawerOpen}
            aria-controls="sidebar"
            onClick={() => {
              setSidebarDrawerOpen(open => !open);
              setInspectorDrawerOpen(false);
            }}
          >
            {t("nav.openNav")}
          </button>
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
          <button
            type="button"
            class="panelToggle ghost"
            aria-expanded={inspectorDrawerOpen}
            aria-controls="inspector"
            disabled={!project}
            onClick={() => {
              setInspectorDrawerOpen(open => !open);
              setSidebarDrawerOpen(false);
            }}
          >
            {t("inspector.openPanel")}
          </button>
          <div class="langSwitch" role="group" aria-label="语言 / Language" title="语言 / Language">
            <button type="button" data-lang="zh" aria-pressed={lang === "zh"} class={lang === "zh" ? "active" : ""} onClick={() => setLang("zh")}>中</button>
            <button type="button" data-lang="en" aria-pressed={lang === "en"} class={lang === "en" ? "active" : ""} onClick={() => setLang("en")}>EN</button>
          </div>
          <button type="button" class="ghost" onClick={() => void openSettings()}>{t("settings.title")}</button>
        </div>
      </header>

      <main class="layout">
        <aside id="sidebar" class={`sidebar${sidebarDrawerOpen ? " drawerOpen" : ""}`}>
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
          onRemoveUpload={removeUpload}
          onOpenMedia={setMedia}
          onFilesDropped={files => void uploadFiles(files)}
          onDropTransfer={handleDropTransfer}
          onConfirmSubmit={handleConfirmSubmit}
          onConfirmDecline={handleConfirmDecline}
        />

        <Inspector
          className={inspectorDrawerOpen ? "drawerOpen" : ""}
          project={project}
          shots={shots}
          skills={skills}
          jobs={jobs}
          inspectorTab={inspectorTab}
          assetFilter={assetFilter}
          skillFilter={skillFilter}
          showAllSkills={showAllSkills}
          onTabChange={tab => {
            setInspectorTab(tab);
            setInspectorDrawerOpen(true);
          }}
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
          onCloseDrawer={() => setInspectorDrawerOpen(false)}
        />
      </main>

      {drawerOpen ? (
        <button
          type="button"
          class="panelScrim"
          aria-label={t("misc.close")}
          onClick={() => {
            setInspectorDrawerOpen(false);
            setSidebarDrawerOpen(false);
          }}
        />
      ) : null}

      {dragActive && project ? (
        <div class="dropOverlay" aria-hidden="true">
          <div class="dropCard">
            <b>{t("drop.title")}</b>
            <span>{t("drop.hint")}</span>
          </div>
        </div>
      ) : null}

      <MediaDialog media={media} onClose={() => setMedia(null)} />
      <PromptDialog request={promptRequest} onClose={() => setPromptRequest(null)} />
      <ConfirmDialog request={confirmRequest} onClose={() => setConfirmRequest(null)} />
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
