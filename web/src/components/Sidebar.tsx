import type { ProjectSummary, StylePackSummary } from "../lib/types";
import { formatUpdatedAt, learningLabel, stageLabel } from "../lib/utils";
import { t } from "../lib/i18n";

type SidebarProps = {
  projects: ProjectSummary[];
  packs: StylePackSummary[];
  currentProjectId: string | null;
  onSelectProject: (id: string) => void;
  onNewProject: () => void;
};

export function Sidebar({
  projects,
  packs,
  currentProjectId,
  onSelectProject,
  onNewProject,
}: SidebarProps) {
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
            <button
              key={project.id}
              type="button"
              class={`projectItem ${currentProjectId === project.id ? "active" : ""}`}
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
          ))
        )}
      </div>
      <div class="sideHeader packsHeader">
        <span>{t("nav.stylePacks")}</span>
      </div>
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
              title={t("nav.packHint", { id: pack.id })}
            >
              <strong>{pack.title}</strong>
              <p>{pack.summary}</p>
              <p>
                {pack.characters.join(t("misc.listSeparator")) || t("nav.noCharacters")}
                {" · "}
                {t("units.shots", { count: pack.shotCount })}
              </p>
            </div>
          ))
        )}
      </div>
    </>
  );
}