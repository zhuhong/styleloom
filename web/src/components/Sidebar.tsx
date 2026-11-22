import { useState } from "preact/hooks";
import type { ProjectSummary, StylePackSummary } from "../lib/types";
import { formatUpdatedAt, learningLabel, stageLabel } from "../lib/utils";
import { t } from "../lib/i18n";

type SidebarProps = {
  projects: ProjectSummary[];
  packs: StylePackSummary[];
  currentProjectId: string | null;
  onSelectProject: (id: string) => void;
  onNewProject: () => void;
  onRenameProject: (id: string, currentTitle: string) => void;
  onDeleteProject: (id: string, title: string) => void;
};

export function Sidebar({
  projects,
  packs,
  currentProjectId,
  onSelectProject,
  onNewProject,
  onRenameProject,
  onDeleteProject,
}: SidebarProps) {
  // 风格包默认折叠，给项目列表腾地方。
  const [packsOpen, setPacksOpen] = useState(false);

  // API 已按 updatedAt → createdAt 逆序；这里再排一次，避免前端本地插入后乱序。
  const orderedProjects = projects.slice().sort((left, right) => {
    const byUpdated = String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""));
    if (byUpdated) return byUpdated;
    return String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? ""));
  });

  return (
    <>
      <div class="sideHeader">
        <span>{t("nav.projects")}</span>
        <button
          id="newProjectButton"
          class="iconButton"
          type="button"
          title={t("nav.newProject")}
          onClick={onNewProject}
        >
          ＋
        </button>
      </div>
      <div id="projectList" class="projectList">
        {!orderedProjects.length ? (
          <p class="muted" style="font-size:12px;padding:0 6px">
            {t("nav.noProjects")}
          </p>
        ) : (
          orderedProjects.map((project) => (
            <div
              key={project.id}
              class={`projectItem ${currentProjectId === project.id ? "active" : ""}`}
            >
              <button
                type="button"
                class="projectMain"
                onClick={() => onSelectProject(project.id)}
              >
                <strong>{project.title}</strong>
                <span>
                  {t("misc.projectMeta", {
                    stage: stageLabel(project.stage),
                    count: project.shotCount,
                    learning: learningLabel(project.learning),
                  })}
                </span>
                <span class="projectTimes">
                  {t("nav.projectCreated", { time: formatUpdatedAt(project.createdAt) })}
                  {" · "}
                  {t("nav.projectUpdated", { time: formatUpdatedAt(project.updatedAt) })}
                </span>
              </button>
              <div class="projectActions">
                <button
                  type="button"
                  class="projectAction"
                  title={t("nav.renameProject")}
                  aria-label={t("nav.renameProject")}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRenameProject(project.id, project.title);
                  }}
                >
                  ✎
                </button>
                <button
                  type="button"
                  class="projectAction danger"
                  title={t("nav.deleteProject")}
                  aria-label={t("nav.deleteProject")}
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeleteProject(project.id, project.title);
                  }}
                >
                  ×
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      <button
        type="button"
        class={`sideHeader packsHeader packsToggle ${packsOpen ? "open" : ""}`}
        aria-expanded={packsOpen}
        aria-controls="packList"
        onClick={() => setPacksOpen(open => !open)}
      >
        <span class="packsToggleLabel">
          <span class="packsChevron" aria-hidden="true">{packsOpen ? "▾" : "▸"}</span>
          {t("nav.stylePacks")}
        </span>
        <span class="packsCount">{packs.length}</span>
      </button>
      {packsOpen ? (
        <div id="packList" class="packList">
          {!packs.length ? (
            <p class="muted" style="font-size:12px;padding:0 6px">
              {t("nav.noPacks")}
            </p>
          ) : (
            packs.map((pack) => (
              <div
                key={pack.id}
                class="packItem"
              >
                <strong>{pack.title}</strong>
                <p>{pack.summary}</p>
                <p>
                  {pack.characters.join(t("misc.listSeparator")) || t("nav.noCharacters")}
                  {" · "}
                  {t("units.shots", { count: pack.shotCount })}
                </p>
                <p class="packHint">{t("nav.packHint", { id: pack.id })}</p>
              </div>
            ))
          )}
        </div>
      ) : null}
    </>
  );
}
