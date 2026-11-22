import { useEffect, useState } from "preact/hooks";
import type { MediaRequest, Project } from "../../lib/types";
import {
  fileUrl,
  mediaTypeForPath,
} from "../../lib/utils";
import { t } from "../../lib/i18n";

type AssetFilter = "all" | "video" | "image" | "audio" | "other";

const PAGE_SIZE = 24;

type AssetsProps = {
  project: Project;
  assetFilter: string;
  onAssetFilter: (filter: AssetFilter) => void;
  onOpenMedia: (media: MediaRequest) => void;
};

export function Assets({ project, assetFilter, onAssetFilter, onOpenMedia }: AssetsProps) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const items = (project.assets || []).slice().reverse().map((asset) => ({
    asset,
    type: (mediaTypeForPath(asset.path) || "other") as AssetFilter | "other",
  }));
  const counts = { all: items.length, video: 0, image: 0, audio: 0, other: 0 };
  for (const item of items) counts[item.type as keyof typeof counts] += 1;

  const filterEntries: [AssetFilter, string, number][] = [
    ["all", t("assets.all"), counts.all],
    ["video", t("media.video"), counts.video],
    ["image", t("media.image"), counts.image],
    ["audio", t("media.audio"), counts.audio],
    ["other", t("assets.other"), counts.other],
  ];
  const filters = filterEntries.filter((entry): entry is [AssetFilter, string, number] => entry[2] > 0);

  const filter = filters.some(([value]) => value === assetFilter) ? assetFilter as AssetFilter : "all";
  const filtered = filter === "all" ? items : items.filter((item) => item.type === filter);
  const visible = filtered.slice(0, limit);

  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [project.id, filter]);
  const typeLabels: Record<string, string> = {
    video: t("media.video"),
    image: t("media.image"),
    audio: t("media.audio"),
    other: t("assets.file"),
  };

  return (
    <section class="inspectorSection">
      <div class="sectionHead">
        <h3>{t("assets.title")}</h3>
        <span class="count">
          {filter === "all" ? items.length : `${filtered.length} / ${items.length}`}
        </span>
      </div>
      <div class="filterChips">
        {filters.map(([value, label, count]) => (
          <button
            key={value}
            type="button"
            class={`filterChip ${filter === value ? "active" : ""}`}
            onClick={() => onAssetFilter(value)}
          >
            {label}
            <span>{count}</span>
          </button>
        ))}
      </div>
      {visible.length ? (
        <div class="assetGrid">
          {visible.map(({ asset, type }) => {
            const src = fileUrl(project.id, asset.path);
            const title = asset.label;
            if (type === "other") {
              return (
                <a key={asset.path} class="assetPlain" href={src} target="_blank" rel="noreferrer">
                  {asset.kind} · {asset.label}
                </a>
              );
            }
            // 视频缩略不挂 <video>，避免素材网格并发拉 metadata；点开 MediaDialog 再播。
            const thumb = type === "image"
              ? <img loading="lazy" src={src} alt="" />
              : type === "video"
                ? (
                  <>
                    <span class="assetVideoFallback" aria-hidden="true" />
                    <span class="assetPlay">▶</span>
                  </>
                )
                : <span class="assetAudio">♪</span>;

            return (
              <button
                key={asset.path}
                class="assetCard"
                type="button"
                title={title}
                onClick={() => onOpenMedia({
                  src,
                  type,
                  title,
                  openUrl: src,
                })}
              >
                <span class="assetThumb">{thumb}</span>
                <span class="assetLabel">
                  <b>{typeLabels[type]}</b>
                  {asset.label}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p class="emptyHint">
          {filter === "all" ? t("assets.empty") : t("assets.emptyFilter")}
        </p>
      )}
      {filtered.length > visible.length ? (
        <div class="assetsMore">
          <p class="sectionHint">
            {t("assets.showing", { visible: visible.length, total: filtered.length })}
          </p>
          <button
            type="button"
            class="textButton"
            onClick={() => setLimit(current => current + PAGE_SIZE)}
          >
            {t("assets.loadMore", { count: Math.min(PAGE_SIZE, filtered.length - visible.length) })}
          </button>
        </div>
      ) : null}
    </section>
  );
}