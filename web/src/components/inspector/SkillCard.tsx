import type { SkillSummary } from "../../lib/types";
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
};

export function SkillCard({ skill, onOpenMedia }: SkillCardProps) {
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
          used: skill.used,
          good: skill.good,
          mixed: skill.mixed,
          bad: skill.bad,
        })}
      </p>
    </details>
  );
}