import { useEffect, useRef } from "preact/hooks";
import type { MediaRequest } from "../lib/types";
import { mediaTypeForPath } from "../lib/utils";
import { t } from "../lib/i18n";

type MediaDialogProps = {
  media: MediaRequest | null;
  onClose: () => void;
};

function sizeDialog(dialog: HTMLDialogElement, width: number, height: number) {
  if (!width || !height) return;
  dialog.style.width = height > width
    ? "min(420px, calc(100vw - 32px))"
    : "min(1120px, calc(100vw - 32px))";
}

function resetPlayers(
  dialog: HTMLDialogElement,
  video: HTMLVideoElement,
  audio: HTMLAudioElement,
  image: HTMLImageElement,
) {
  video.pause();
  video.removeAttribute("src");
  video.removeAttribute("poster");
  video.load();
  video.hidden = true;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  audio.hidden = true;
  image.removeAttribute("src");
  image.alt = "";
  image.hidden = true;
  dialog.style.width = "";
}

export function MediaDialog({ media, onClose }: MediaDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const openLinkRef = useRef<HTMLAnchorElement>(null);
  const closingRef = useRef(false);

  const close = () => {
    const dialog = dialogRef.current;
    if (!dialog?.open) return;
    closingRef.current = true;
    dialog.close();
    if (videoRef.current && audioRef.current && imageRef.current) {
      resetPlayers(dialog, videoRef.current, audioRef.current, imageRef.current);
    }
    onClose();
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    const video = videoRef.current;
    const audio = audioRef.current;
    const image = imageRef.current;
  if (!dialog || !video || !audio || !image) return;

    if (!media?.src) {
      if (dialog.open) {
        closingRef.current = true;
        dialog.close();
      }
      resetPlayers(dialog, video, audio, image);
      return;
    }

    closingRef.current = false;
    resetPlayers(dialog, video, audio, image);

    const kind = media.type || mediaTypeForPath(media.src) || "image";
    const kindLabel = kind === "video" ? t("media.video") : kind === "audio" ? t("media.audio") : t("media.image");
    const cleanTitle = String(media.title || "").replace(/^(frame|video|still|source|clip|audio)\s*·\s*/i, "");
    if (titleRef.current) {
      titleRef.current.textContent = cleanTitle ? `${kindLabel} · ${cleanTitle}` : kindLabel;
    }
    if (openLinkRef.current) {
      openLinkRef.current.href = media.openUrl || media.src;
    }

    if (kind === "video") {
      video.onloadedmetadata = () => sizeDialog(dialog, video.videoWidth, video.videoHeight);
      video.src = media.src;
      video.hidden = false;
      video.play().catch(() => {});
    } else if (kind === "audio") {
      dialog.style.width = "min(560px, calc(100vw - 32px))";
      audio.src = media.src;
      audio.hidden = false;
      audio.play().catch(() => {});
    } else {
      image.onload = () => sizeDialog(dialog, image.naturalWidth, image.naturalHeight);
      image.src = media.src;
      image.alt = media.title || "";
      image.hidden = false;
    }

    if (!dialog.open) dialog.showModal();
  }, [media?.src, media?.type, media?.title, media?.openUrl]);

  return (
    <dialog
      ref={dialogRef}
      class="mediaDialog"
      onClick={(event) => {
        if (event.target === dialogRef.current) close();
      }}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClose={() => {
        if (closingRef.current) {
          closingRef.current = false;
          const dialog = dialogRef.current;
          const video = videoRef.current;
          const audio = audioRef.current;
          const image = imageRef.current;
          if (dialog && video && audio && image) resetPlayers(dialog, video, audio, image);
        }
      }}
    >
      <div class="mediaDialogBar">
        <div ref={titleRef} id="mediaDialogTitle" class="mediaDialogTitle" />
        <div class="mediaDialogActions">
          <a
            ref={openLinkRef}
            id="mediaDialogOpen"
            class="ghost"
            target="_blank"
            rel="noreferrer"
          >
            {t("media.openOriginal")}
          </a>
          <button
            id="mediaDialogClose"
            class="iconButton"
            type="button"
            aria-label={t("misc.close")}
            onClick={close}
          >
            ×
          </button>
        </div>
      </div>
      <div class="mediaDialogBody">
        <img ref={imageRef} id="mediaDialogImage" alt="" hidden />
        <video ref={videoRef} id="mediaDialogVideo" controls playsinline hidden />
        <audio ref={audioRef} id="mediaDialogAudio" controls hidden />
      </div>
    </dialog>
  );
}