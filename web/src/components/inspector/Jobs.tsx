import type { MediaRequest, Project, RenderJob } from "../../lib/types";
import {
  fileUrl,
  formatElapsed,
  jobStatusLabel,
} from "../../lib/utils";
import { t } from "../../lib/i18n";

type JobsProps = {
  project: Project;
  jobs: RenderJob[];
  onOpenMedia: (media: MediaRequest) => void;
  onResumeShot: (shotId: string) => void;
};

export function Jobs({ project, jobs, onOpenMedia, onResumeShot }: JobsProps) {
  const active = jobs.filter((job) => job.status === "running").length;
  const countLabel = active
    ? t("jobs.active", { count: active })
    : jobs.length ? t("jobs.count", { count: jobs.length }) : t("jobs.empty");

  const header = (
    <>
      <div class="sectionHead">
        <h3>{t("jobs.title")}</h3>
        <span class="count">{countLabel}</span>
      </div>
      <p class="sectionHint">{t("jobs.hint")}</p>
    </>
  );

  if (!jobs.length) {
    return (
      <section class="inspectorSection">
        {header}
        <p class="emptyHint">{t("jobs.emptyHint")}</p>
      </section>
    );
  }

  return (
    <section class="inspectorSection">
      {header}
      {jobs.map((job) => {
        const percent = Math.max(0, Math.min(100, Math.round(job.percent || 0)));
        const status = job.status;
        const videoUrl = job.video ? fileUrl(project.id, job.video) : "";
        const canResume = status === "pending" && job.videoId;

        return (
          <div key={job.id} class={`jobCard ${status}`}>
            <div class="jobHead">
              <b>{job.shotId}</b>
              <span class={`state ${status}`}>{jobStatusLabel(status)}</span>
              <span class="jobElapsed">{formatElapsed(job.startedAt)}</span>
            </div>
            <div class="progress">
              <i style={{ width: `${percent}%` }} />
            </div>
            <div class="jobLabel">{percent}% · {job.label || ""}</div>
            {job.videoId ? <div class="jobMeta">video_id {job.videoId}</div> : null}
            {job.error ? <p class="inlineWarning error">{job.error}</p> : null}
            <div class="jobActions">
              {videoUrl ? (
                <button
                  class="textButton"
                  type="button"
                  onClick={() => onOpenMedia({
                    src: videoUrl,
                    type: "video",
                    title: job.shotId,
                    openUrl: videoUrl,
                  })}
                >
                  {t("jobs.play")}
                </button>
              ) : null}
              {canResume ? (
                <button
                  class="textButton"
                  type="button"
                  onClick={() => onResumeShot(job.shotId)}
                >
                  {t("jobs.resume")}
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </section>
  );
}