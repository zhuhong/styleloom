import type { ProjectSummary, StylePackSummary } from "../lib/types";
import { learningLabel, stageLabel } from "../lib/utils";
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
        {!projects.length ? (
          <p class="muted" style="font-size:12px;padding:0 6px">
            {t("nav.noProjects")}
          </p>
        ) : (
          projects.map((project) => (
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