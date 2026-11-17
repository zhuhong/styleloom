import type { MediaRequest, PlanShot, Project, RenderJob } from "../../lib/types";
import {
  fileUrl,
  formatSeconds,
  shotStatusLabel,
} from "../../lib/utils";
import { t } from "../../lib/i18n";

type PlanProps = {
  project: Project;
  jobs: RenderJob[];
  onOpenMedia: (media: MediaRequest) => void;
  onTabChange: (tab: "jobs") => void;
};

export function Plan({ project, jobs, onOpenMedia, onTabChange }: PlanProps) {
  const plan = project.plan || [];
  const jobByShot = new Map<string, RenderJob>();
  for (const job of jobs) {
    if (job.status === "running" || job.status === "pending") jobByShot.set(job.shotId, job);
  }

  if (!plan.length) {
    return (
      <section class="inspectorSection">
        <div class="sectionHead">
          <h3>{t("plan.title")}</h3>
          <span class="count">0</span>
        </div>
        <p class="emptyHint">{t("plan.empty")}</p>
      </section>
    );
  }

  return (
    <section class="inspectorSection">
      <div class="sectionHead">
        <h3>{t("plan.title")}</h3>
      </div>
      <p class="sectionHint">{t("plan.hint")}</p>
      {plan.map((shot: PlanShot) => {
        const videoUrl = shot.video ? fileUrl(project.id, shot.video) : "";
        const preview = shot.video
          ? (project.assets || []).find((asset) => asset.kind === "frame"
            && asset.meta?.shotId === shot.id
            && (asset.label.includes("预览") || asset.path.includes("preview")))
          : undefined;
        const posterUrl = preview ? fileUrl(project.id, preview.path) : "";
        const liveJob = jobByShot.get(shot.id);
        const livePercent = liveJob ? Math.max(0, Math.min(100, Math.round(liveJob.percent || 0))) : 0;

        return (
          <div key={shot.id} class="planRow">
            <div class="planBody">
              <div class="planMiniMedia">
                {shot.video ? (
                  <button
                    class="videoPoster mini"
                    type="button"
                    aria-label={t("plan.previewAria", { id: shot.id })}
                    onClick={() => onOpenMedia({
                      src: videoUrl,
                      type: "video",
                      title: `${shot.id} ${shot.title}`,
                      openUrl: videoUrl,
                    })}
                  >
                    <video
                      muted
                      preload="metadata"
                      playsinline
                      poster={posterUrl || undefined}
                      src={videoUrl}
                    />
                    <span class="playBadge"><span>▶</span></span>
                  </button>
                ) : (
                  <div class="planPlaceholder mini">
                    {shot.status === "generating" ? t("plan.generating") : t("plan.notGenerated")}
                  </div>
                )}
              </div>
              <div class="planInfo">
                <div class="planHead">
                  <b>{shot.id}</b>
                  <span class="muted">{formatSeconds(shot.durationSeconds)}</span>
                  {shot.durationSeconds < 4 ? (
                    <span class="shortBadge" title={t("plan.shortBadgeTitle")}>{t("plan.shortBadge")}</span>
                  ) : null}
                  <span class={`state ${shot.status}`}>{shotStatusLabel(shot.status)}</span>
                </div>
                <p class="planAction"><b>{shot.title}</b></p>
                {liveJob ? (
                  <div class="planLive">
                    <div class="progress">
                      <i style={{ width: `${livePercent}%` }} />
                    </div>
                    <span class="planLiveLabel">
                      {livePercent}% · {liveJob.label || ""}
                    </span>
                    <button class="textButton" type="button" onClick={() => onTabChange("jobs")}>
                      {t("plan.viewJobs")}
                    </button>
                  </div>
                ) : null}
                {shot.action ? (
                  <details class="fold planDetails">
                    <summary>{t("plan.action")}</summary>
                    <p>{shot.action}</p>
                  </details>
                ) : null}
                {shot.error ? <p class="inlineWarning error">{shot.error}</p> : null}
                {shot.prompt ? (
                  <details>
                    <summary>{t("plan.prompt", { mode: shot.promptMode || "" })}</summary>
                    <pre>{shot.prompt}</pre>
                  </details>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </section>
  );
}