import type { Brief, LearningState, Project, ReferenceShot, StyleBible } from "../../lib/types";
import {
  fileUrl,
  formatSeconds,
  learningStateLabel,
  readableLearningWarning,
} from "../../lib/utils";
import { t } from "../../lib/i18n";
import type { MediaRequest } from "../../lib/types";
import { Entity } from "./Entity";

type OverviewProps = {
  project: Project;
  shots: ReferenceShot[];
  bible: StyleBible | null | undefined;
  brief: Brief;
  learning: LearningState;
  onOpenMedia: (media: MediaRequest) => void;
};

export function Overview({ project, shots, bible, brief, learning, onOpenMedia }: OverviewProps) {
  const resolution = learning.sourceWidth && learning.sourceHeight
    ? `${learning.sourceWidth}×${learning.sourceHeight}`
  : "";

  const sections = [
    <section key="brief" class="inspectorSection">
      <div class="sectionHead">
        <h3>{t("brief.title")}</h3>
      </div>
      <div class="briefCard">
        <p class="briefIdea">
          {brief.idea ? brief.idea : <span class="muted">{t("brief.empty")}</span>}
        </p>
        <div class="metaGrid">
          <div>
            <b>{t("brief.genre")}</b>
            <span title={brief.genre || "-"}>{brief.genre || "-"}</span>
          </div>
          <div>
            <b>{t("brief.aspectRatio")}</b>
            <span title={brief.aspectRatio || "-"}>{brief.aspectRatio || "-"}</span>
          </div>
          <div>
            <b>{t("brief.duration")}</b>
            <span title={brief.durationSeconds ? t("units.seconds", { value: brief.durationSeconds }) : "-"}>
              {brief.durationSeconds ? t("units.seconds", { value: brief.durationSeconds }) : "-"}
            </span>
          </div>
        </div>
        {((brief.mustKeep || []).length + (brief.avoid || []).length) ? (
          <details class="fold">
            <summary>
              {t("brief.constraints")}
              {" "}
              <span class="count">
                {t("units.items", { count: (brief.mustKeep || []).length + (brief.avoid || []).length })}
              </span>
            </summary>
            <div class="chips">
              {(brief.mustKeep || []).map((item) => (
                <span key={`keep-${item}`} class="chip">{t("brief.keep", { item })}</span>
              ))}
              {(brief.avoid || []).map((item) => (
                <span key={`avoid-${item}`} class="chip">{t("brief.avoid", { item })}</span>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </section>,

    <section key="learning" class="inspectorSection">
      <div class="sectionHead">
        <h3>{t("learning.title")}</h3>
        <span class="count">{learningStateLabel(learning)}</span>
      </div>
      {learning.error ? <p class="inlineWarning error">{learning.error}</p> : null}
      {learning.warning ? (
        <p class="inlineWarning warn">{readableLearningWarning(learning.warning)}</p>
      ) : null}
      <div class="statRow">
        <span class="stat">
          <b>{learning.shotCount ?? 0}</b>
          {t("units.referenceShots")}
        </span>
        {learning.sourceDuration ? (
          <span class="stat">
            <b>{formatSeconds(learning.sourceDuration)}</b>
            {t("units.duration")}
          </span>
        ) : null}
        {resolution ? (
          <span class="stat">
            <b>{resolution}</b>
            {t("units.resolution")}
          </span>
        ) : null}
      </div>
      {shots.length ? (
        <details class="fold">
          <summary>
            {t("learning.referenceShots")}
            {" "}
            <span class="count">{t("units.count", { count: shots.length })}</span>
          </summary>
          <div class="shotGrid">
            {shots.map((shot) => {
              const src = fileUrl(project.id, shot.keyframe);
              return (
                <div key={shot.id} class="shotCard">
                  <a
                    class="mediaThumb"
                    href={src}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => {
                      event.preventDefault();
                      onOpenMedia({
                        src,
                        type: "image",
                        title: t("learning.keyframeTitle", { id: shot.id }),
                        openUrl: src,
                      });
                    }}
                  >
                    <img loading="lazy" src={src} alt={shot.id} />
                  </a>
                  <div class="shotMeta">
                    <strong>{shot.id} · {formatSeconds(shot.duration)}</strong>
                    {shot.shotSize || "-"}
                    {" · "}
                    {(shot.movement || "").slice(0, 42)}
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      ) : (
        <p class="emptyHint">{t("learning.noShots")}</p>
      )}
    </section>,
  ];

  if (!bible) {
    sections.push(<p key="bible-empty" class="emptyHint">{t("bible.empty")}</p>);
    return <>{sections}</>;
  }

  const characters = bible.characters || [];
  const locations = bible.locations || [];
  const moves = bible.cameraGrammar || [];

  sections.push(
    <section key="bible" class="inspectorSection">
      <div class="sectionHead">
        <h3>{t("bible.title")}</h3>
        <span class="count">{t("bible.perShot", { value: bible.rhythm?.averageShotSeconds ?? "-" })}</span>
      </div>
      <div class="bibleCard">
        <p class="bibleSummary">{bible.summary}</p>
        <div class="chips">
          {characters.map((character) => (
            <span key={character.id} class="chip">{t("bible.characterChip", { name: character.name })}</span>
          ))}
          {locations.map((location) => (
            <span key={location.id} class="chip">{t("bible.locationChip", { name: location.name })}</span>
          ))}
        </div>
        {characters.length || locations.length ? (
          <details class="fold">
            <summary>
              {t("bible.charactersLocations")}
              {" "}
              <span class="count">{t("units.entries", { count: characters.length + locations.length })}</span>
            </summary>
            {characters.map((character) => (
              <Entity key={character.id} project={project} entity={character} kind="character" onOpenMedia={onOpenMedia} />
            ))}
            {locations.map((location) => (
              <Entity key={location.id} project={project} entity={location} kind="location" onOpenMedia={onOpenMedia} />
            ))}
          </details>
        ) : null}
        {moves.length ? (
          <details class="fold">
            <summary>
              {t("bible.cameraGrammar")}
              {" "}
              <span class="count">{t("units.items", { count: moves.length })}</span>
            </summary>
            <ul class="cameraList">
              {moves.map((move) => (
                <li key={move.name}>
                  <b>{move.name}</b>
                  <span>{move.descriptionZh || move.promptFragment || ""}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {bible.style?.stylePrefix ? (
          <details class="fold">
            <summary>{t("bible.stylePrefix")}</summary>
            <p class="stylePrefix">{bible.style.stylePrefix}</p>
          </details>
        ) : null}
      </div>
    </section>,
  );

  return <>{sections}</>;
}