import type { BibleEntity, MediaRequest, Project } from "../../lib/types";
import { fileUrl } from "../../lib/utils";
import { t } from "../../lib/i18n";

type EntityProps = {
  project: Project;
  entity: BibleEntity;
  kind: "character" | "location";
  onOpenMedia: (media: MediaRequest) => void;
};

export function Entity({ project, entity, kind, onOpenMedia }: EntityProps) {
  const images = entity.stillImages || [];
  const imageLabel = kind === "character" ? t("bible.characterStill") : t("bible.locationStill");

  return (
    <div class="entity">
      <div class="entityHead">
        <b>{entity.name}</b>
        <span>{entity.id}</span>
      </div>
      <p>{entity.descriptionZh}</p>
      {images.length ? (
        <div class="thumbs">
          {images.slice(0, 3).map((path) => {
            const src = fileUrl(project.id, path);
            return (
              <a
                key={path}
                class="mediaThumb"
                href={src}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => {
                  event.preventDefault();
                  onOpenMedia({
                    src,
                    type: "image",
                    title: `${entity.name} · ${imageLabel}`,
                    openUrl: src,
                  });
                }}
              >
                <img src={src} alt={entity.name} />
              </a>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}