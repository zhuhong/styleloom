import { useMemo, useRef } from "preact/hooks";
import type {
  InspectorTab,
  MeasureManifest,
  MediaRequest,
  Project,
  ReferenceShot,
  RenderJob,
  SkillRating,
  SkillSummary,
} from "../lib/types";
import {
  formatUpdatedAt,
  stageLabel,
} from "../lib/utils";
import { t } from "../lib/i18n";
import { Overview } from "./inspector/Overview";
import { Plan } from "./inspector/Plan";
import { Jobs } from "./inspector/Jobs";
import { Assets } from "./inspector/Assets";
import { Skills } from "./inspector/Skills";

export type InspectorProps = {
  project: Project | null;
  shots: ReferenceShot[];
  measure?: MeasureManifest | null;
  skills: SkillSummary[];
  jobs: RenderJob[];
  inspectorTab: InspectorTab | null;
  assetFilter: string;
  skillFilter: string;
  showAllSkills: boolean;
  className?: string;
  onTabChange: (tab: InspectorTab) => void;
  onAssetFilter: (filter: string) => void;
  onSkillFilter: (filter: string) => void;
  onToggleShowAllSkills: () => void;
  onOpenMedia: (media: MediaRequest) => void;
  onResumeShot: (shotId: string) => void;
  onShotSkillOutcome?: (shotId: string, rating: SkillRating) => void;
  onVerifyShot?: (shotId: string) => void;
  onSkillOutcome?: (skillId: string, rating: SkillRating) => void;
  skillFeedbackBusy?: string | null;
  verifyBusy?: string | null;
  skillFeedbackNotes?: Record<string, { rating: SkillRating; count?: number }>;
  onCloseDrawer?: () => void;
};

export function Inspector({
  project,
  shots,
  measure,
  skills,
  jobs,
  inspectorTab,
  assetFilter,
  skillFilter,
  showAllSkills,
  className,
  onTabChange,
  onAssetFilter,
  onSkillFilter,
  onToggleShowAllSkills,
  onOpenMedia,
  onResumeShot,
  onShotSkillOutcome,
  onVerifyShot,
  onSkillOutcome,
  skillFeedbackBusy,
  verifyBusy,
  skillFeedbackNotes,
  onCloseDrawer,
}: InspectorProps) {
  const rootRef = useRef<HTMLElement>(null);

  const activeTab = useMemo((): InspectorTab => {
    if (!project) return "overview";
    const planCount = (project.plan || []).length;
    const assetCount = (project.assets || []).length;
    const skillCount = skills.length;
    const runningJobs = jobs.filter((job) => job.status === "running" || job.status === "pending").length;
    const tabs: InspectorTab[] = ["overview", "shots", "jobs", "assets", "skills"];
    const fallback: InspectorTab = runningJobs ? "jobs" : (planCount ? "shots" : "overview");
    if (inspectorTab && tabs.includes(inspectorTab)) return inspectorTab;
    return fallback;
  }, [project, inspectorTab, jobs, skills.length]);

  const rootClass = `inspector${className ? ` ${className}` : ""}`;

  if (!project) {
    return (
      <aside id="inspector" class={rootClass} ref={rootRef}>
        <div class="emptyState small">
          <p>{t("inspector.emptyProject")}</p>
        </div>
      </aside>
    );
  }

  const planCount = (project.plan || []).length;
  const assetCount = (project.assets || []).length;
  const skillCount = skills.length;
  const runningJobs = jobs.filter((job) => job.status === "running" || job.status === "pending").length;
  // Tab 角标：有进行中优先显示进行中数量；否则显示队列条数，避免「有完成任务但角标空白」。
  const jobsBadge = runningJobs || jobs.length;

  const tabs: [InspectorTab, string, number][] = [
    ["overview", t("inspector.tabOverview"), 0],
    ["shots", t("inspector.tabShots"), planCount],
    ["jobs", t("inspector.tabJobs"), jobsBadge],
    ["assets", t("inspector.tabAssets"), assetCount],
    ["skills", t("inspector.tabSkills"), skillCount],
  ];

  const bible = project.styleBible;
  const brief = project.brief || {};
  const learning = project.learning || { status: "none" };

  let content;
  if (activeTab === "overview") {
    content = (
      <Overview
        project={project}
        shots={shots}
        bible={bible}
        brief={brief}
        learning={learning}
        measure={measure}
        onOpenMedia={onOpenMedia}
      />
    );
  } else if (activeTab === "shots") {
    content = (
      <Plan
        project={project}
        jobs={jobs}
        onOpenMedia={onOpenMedia}
        onTabChange={() => onTabChange("jobs")}
        onSkillOutcome={onShotSkillOutcome}
        onVerifyShot={onVerifyShot}
        skillFeedbackBusy={skillFeedbackBusy}
        verifyBusy={verifyBusy}
        skillFeedbackNotes={skillFeedbackNotes}
      />
    );
  } else if (activeTab === "jobs") {
    content = (
      <Jobs
        project={project}
        jobs={jobs}
        onOpenMedia={onOpenMedia}
        onResumeShot={onResumeShot}
      />
    );
  } else if (activeTab === "assets") {
    content = (
      <Assets
        project={project}
        assetFilter={assetFilter}
        onAssetFilter={onAssetFilter}
        onOpenMedia={onOpenMedia}
      />
    );
  } else {
    content = (
      <Skills
        skills={skills}
        skillFilter={skillFilter}
        showAllSkills={showAllSkills}
        onSkillFilter={onSkillFilter}
        onToggleShowAllSkills={onToggleShowAllSkills}
        onOpenMedia={onOpenMedia}
        onRateSkill={onSkillOutcome}
        rateBusyId={skillFeedbackBusy}
        skillFeedbackNotes={skillFeedbackNotes}
      />
    );
  }

  const handleTabClick = (tab: InspectorTab) => {
    if (rootRef.current) rootRef.current.scrollTop = 0;
    onTabChange(tab);
  };

  return (
    <aside id="inspector" class={rootClass} ref={rootRef}>
      <header class="inspectorHeader">
        <div class="inspectorTitleRow">
          <div class="inspectorTitleText">
            <h2>{project.title}</h2>
            <p>{t("inspector.updatedAt", { time: formatUpdatedAt(project.updatedAt) })}</p>
          </div>
          <div class="inspectorTitleActions">
            <span class="stageBadge">{stageLabel(project.stage)}</span>
            {onCloseDrawer ? (
              <button
                type="button"
                class="iconButton drawerClose"
                aria-label={t("misc.close")}
                onClick={onCloseDrawer}
              >
                ×
              </button>
            ) : null}
          </div>
        </div>
        <nav class="inspectorTabs" role="tablist">
          {tabs.map(([id, label, count]) => (
            <button
              key={id}
              type="button"
              class={`inspectorTab ${activeTab === id ? "active" : ""}`}
              role="tab"
              aria-selected={activeTab === id}
              onClick={() => handleTabClick(id)}
            >
              {label}
              {count ? <span>{count}</span> : null}
            </button>
          ))}
        </nav>
      </header>
      <div class="inspectorContent">{content}</div>
    </aside>
  );
}