import { useMemo, useRef } from "preact/hooks";
import type {
  InspectorTab,
  MediaRequest,
  Project,
  ReferenceShot,
  RenderJob,
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
  skills: SkillSummary[];
  jobs: RenderJob[];
  inspectorTab: InspectorTab | null;
  assetFilter: string;
  skillFilter: string;
  showAllSkills: boolean;
  onTabChange: (tab: InspectorTab) => void;
  onAssetFilter: (filter: string) => void;
  onSkillFilter: (filter: string) => void;
  onToggleShowAllSkills: () => void;
  onOpenMedia: (media: MediaRequest) => void;
  onResumeShot: (shotId: string) => void;
};

export function Inspector({
  project,
  shots,
  skills,
  jobs,
  inspectorTab,
  assetFilter,
  skillFilter,
  showAllSkills,
  onTabChange,
  onAssetFilter,
  onSkillFilter,
  onToggleShowAllSkills,
  onOpenMedia,
  onResumeShot,
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

  if (!project) {
    return (
      <aside id="inspector" class="inspector" ref={rootRef}>
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

  const tabs: [InspectorTab, string, number][] = [
    ["overview", t("inspector.tabOverview"), 0],
    ["shots", t("inspector.tabShots"), planCount],
    ["jobs", t("inspector.tabJobs"), runningJobs],
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
      />
    );
  }

  const handleTabClick = (tab: InspectorTab) => {
    if (rootRef.current) rootRef.current.scrollTop = 0;
    onTabChange(tab);
  };

  return (
    <aside id="inspector" class="inspector" ref={rootRef}>
      <header class="inspectorHeader">
        <div class="inspectorTitleRow">
          <div class="inspectorTitleText">
            <h2>{project.title}</h2>
            <p>{t("inspector.updatedAt", { time: formatUpdatedAt(project.updatedAt) })}</p>
          </div>
          <span class="stageBadge">{stageLabel(project.stage)}</span>
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