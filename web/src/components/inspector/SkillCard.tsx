import { useEffect, useState } from "preact/hooks";
import type { SkillRating, SkillSummary } from "../../lib/types";
import {
  skillFileUrl,
  skillKindLabel,
  skillStatusLabel,
} from "../../lib/utils";
import { t } from "../../lib/i18n";
import type { MediaRequest } from "../../lib/types";

type SkillCardProps = {
  skill: SkillSummary;
  onOpenMedia: (media: MediaRequest) => void;
  onRate?: (skillId: string, rating: SkillRating) => void;
  rateBusy?: boolean;
  savedRating?: SkillRating;
};

export function SkillCard({ skill, onOpenMedia, onRate, rateBusy, savedRating }: SkillCardProps) {
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (savedRating) setEditing(false);
  }, [savedRating]);
  return (
    <details class="skillCard">
      <summary>
        <span class="skillName">{skill.name}</span>
        <span class="skillKind">{skillKindLabel(skill.kind)}</span>
        <span class="skillConfidence">{Number(skill.confidence).toFixed(2)}</span>
      </summary>
      <p>{skill.summaryZh}</p>
      {(skill.applicableWhen || []).length ? (
        <div class="chips">
          {skill.applicableWhen!.map((item) => (
            <span key={item} class="chip">{item}</span>
          ))}
        </div>
      ) : null}
      {skill.instruction ? <p class="skillInstruction">{skill.instruction}</p> : null}
      {skill.promptFragment ? <pre>{skill.promptFragment}</pre> : null}
      {(skill.images || []).length ? (
        <div class="thumbs">
          {skill.images!.map((image) => {
            const src = skillFileUrl(skill.id, image);
            return (
              <a
                key={image}
                class="mediaThumb"
                href={src}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => {
                  event.preventDefault();
                  onOpenMedia({
                    src,
                    type: "image",
                    title: t("skills.evidenceTitle", { name: skill.name }),
                    openUrl: src,
                  });
                }}
              >
                <img loading="lazy" src={src} alt={skill.name} />
              </a>
            );
          })}
        </div>
      ) : null}
      <p class="skillStats">
        <span class={`statusDot ${skill.status}`} />
        {skillStatusLabel(skill.status)}
        {" · "}
        {t("skills.stats", {
          evidence: skill.evidenceCount,
          projects: skill.uniqueProjects ?? 0,
          used: skill.used,
          good: skill.good,
          mixed: skill.mixed,
          bad: skill.bad,
        })}
        {skill.needsFeedback ? ` · ${t("skills.needsFeedback")}` : ""}
      </p>
      {onRate && skill.source !== "public" ? (
        savedRating && !editing ? (
          <div class="skillFeedbackRow collapsed">
            <span class="skillFeedbackSaved">
              {t("skills.rateSaved", { rating: t(`skills.rate.${savedRating}`) })}
            </span>
            <button
              class="textButton"
              type="button"
              disabled={rateBusy}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setEditing(true);
              }}
            >
              {t("skills.rateChange")}
            </button>
          </div>
        ) : (
          <div class="skillFeedbackRow">
            <span class="skillFeedbackLabel">{t("skills.rateLabel")}</span>
            {(["good", "mixed", "bad"] as SkillRating[]).map((rating) => (
              <button
                key={rating}
                class={`skillRateBtn ${rating}${savedRating === rating ? " active" : ""}`}
                type="button"
                disabled={rateBusy}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setEditing(false);
                  onRate(skill.id, rating);
                }}
              >
                {t(`skills.rate.${rating}`)}
              </button>
            ))}
          </div>
        )
      ) : null}
    </details>
  );
}
