import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatAttachment, ChatItem, MediaRequest, PendingUpload } from "../lib/types";
import {
  fileUrl,
  formatDuration,
  formatFileSize,
  mediaTypeForPath,
  toolLabel,
} from "../lib/utils";
import type { ToolCardState } from "../lib/types";
import { t } from "../lib/i18n";
import { renderMarkdown } from "../lib/markdown";

const panelScopedTools = new Set(["generate_shot", "resume_shot"]);

type ChatPaneProps = {
  projectId: string | null;
  items: ChatItem[];
  streaming: boolean;
  uploading: number;
  pendingUploads: PendingUpload[];
  input: string;
  onInputChange: (value: string) => void;
  onSend: (message: string, attachments: ChatAttachment[]) => void;
  onAttach?: () => void;
  onRemoveUpload: (index: number) => void;
  onOpenMedia: (media: MediaRequest) => void;
  onFilesDropped: (files: FileList | File[]) => void;
};

function BubbleAttachment({
  projectId,
  attachment,
  onOpenMedia,
}: {
  projectId: string | null;
  attachment: ChatAttachment;
  onOpenMedia: (media: MediaRequest) => void;
}) {
  const src = fileUrl(projectId ?? undefined, attachment.path);
  const type = attachment.kind || mediaTypeForPath(attachment.path) || "image";
  const label = attachment.label || attachment.path.split("/").pop() || t("media.attachment");

  return (
    <button
      type="button"
      class="bubbleAttachment"
      title={attachment.label || attachment.path}
      onClick={() => onOpenMedia({
        src,
        type,
        title: label,
        openUrl: src,
      })}
    >
      <span class="bubbleAttachmentThumb">
        {type === "video" ? (
          <span class="uploadVideoIcon">▶</span>
        ) : (
          <img src={src} alt="" loading="lazy" />
        )}
      </span>
      <span class="bubbleAttachmentName">{label}</span>
    </button>
  );
}

function ToolCardView({ card }: { card: ToolCardState }) {
  const inPanel = card.panel || panelScopedTools.has(card.name);
  const statusClass = card.status === "done" ? "ok" : card.status === "failed" ? "fail" : "";
  const progressWidth = card.status === "done" ? 100 : Math.max(0, Math.min(100, card.percent));

  let labelText = card.label || t("tool.preparing");
  if (inPanel) {
    if (card.status === "running") labelText = t("plan.panelHint");
    else if (card.status === "done") labelText = t("plan.panelDone");
    else if (card.preview) labelText = card.preview.slice(0, 200);
  } else if (card.status === "running") {
    labelText = `${card.percent}% · ${card.label}`;
  } else if (card.preview) {
    labelText = card.preview.slice(0, 300);
  }

  const elapsed = card.elapsedMs != null
    ? formatDuration(card.elapsedMs)
    : formatDuration(performance.now() - card.startedAt);

  return (
    <div class="toolCard" data-id={card.id} data-panel={inPanel ? "1" : "0"} data-started-at={String(card.startedAt)}>
      <div class="toolHead">
        <span class="toolName">{toolLabel(card.name)}</span>
        <span class="muted">{card.name}</span>
        <span class={`status ${statusClass}`}>
          {card.status === "running"
            ? t("tool.running")
            : card.status === "done"
              ? t("tool.done")
              : t("tool.failed")}
        </span>
        {card.status !== "running" ? (
          <span class="toolDuration" title={t("tool.elapsedTitle")}>
            {t("tool.elapsed", { time: elapsed })}
          </span>
        ) : (
          <span class="toolDuration" />
        )}
      </div>
      <div class="toolArgs">{JSON.stringify(card.args ?? {}).slice(0, 400)}</div>
      {inPanel ? (
        <div class="progressLabel panelHint">{labelText}</div>
      ) : (
        <>
          <div class="progress">
            <i style={{ width: `${Math.max(0, Math.min(100, progressWidth))}%` }} />
          </div>
          <div class="progressLabel">{labelText}</div>
        </>
      )}
    </div>
  );
}

function EmptyChat() {
  return (
    <div class="emptyState">
      <h2>{t("chat.emptyTitle")}</h2>
      <p dangerouslySetInnerHTML={{ __html: t("chat.emptyExample") }} />
      <p>{t("chat.emptyXhs")}</p>
      <p>{t("chat.emptyFlow")}</p>
    </div>
  );
}

export function ChatPane({
  projectId,
  items,
  streaming,
  uploading,
  pendingUploads,
  input,
  onInputChange,
  onSend,
  onAttach,
  onRemoveUpload,
  onOpenMedia,
  onFilesDropped,
}: ChatPaneProps) {
  const messagesRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const busy = streaming || uploading > 0;

  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, pendingUploads, streaming]);

  const handleSubmit = (event: Event) => {
    event.preventDefault();
    const message = input.trim();
    const attachments = pendingUploads
      .filter((item) => item.status === "done" && item.asset)
      .map((item) => ({
        path: item.asset!.path,
        label: item.asset!.label,
        kind: item.kind,
        mimeType: item.mimeType,
        size: item.size,
      }));
    if ((!message && !attachments.length) || busy) return;
    onSend(message, attachments);
  };

  const handleMessagesClick = (event: MouseEvent) => {
    const target = event.target as Element;
    const trigger = target.closest("[data-media-src]") as HTMLElement | null;
    if (!trigger) return;
    event.preventDefault();
    const src = trigger.dataset.mediaSrc;
    if (!src) return;
    onOpenMedia({
      src,
      type: trigger.dataset.mediaType || mediaTypeForPath(src) || "image",
      title: trigger.dataset.mediaTitle || "",
      openUrl: trigger.dataset.mediaOpen || trigger.getAttribute("href") || src,
    });
  };

  return (
    <section class="chatPane">
      <div
        id="messages"
        ref={messagesRef}
        class="messages"
        onClick={handleMessagesClick}
      >
        {!items.length ? <EmptyChat /> : null}
        {items.map((item) => {
          if (item.kind === "bubble") {
            const isMarkdown = item.role === "assistant" && !item.isError;
            const className = `bubble ${item.isError ? "error" : item.role}${isMarkdown ? " markdown" : ""}`;
            return (
              <div key={item.id} class={className}>
                {isMarkdown ? (
                  <span dangerouslySetInnerHTML={{ __html: renderMarkdown(item.content) }} style={{ display: "contents" }} />
                ) : (
                  item.content
                )}
                {item.attachments?.length ? (
                  <div class="bubbleAttachments">
                    {item.attachments.map((attachment, index) => (
                      <BubbleAttachment
                        key={`${item.id}-att-${index}`}
                        projectId={projectId}
                        attachment={attachment}
                        onOpenMedia={onOpenMedia}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          }
          return <ToolCardView key={item.id} card={item.card} />;
        })}
      </div>
      <form
        id="composer"
        class={`composer${dragging ? " dragging" : ""}`}
        onSubmit={handleSubmit}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          const composer = event.currentTarget as HTMLElement;
          if (!composer.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (event.dataTransfer?.files?.length) onFilesDropped(event.dataTransfer.files);
        }}
      >
        <button
          id="attachButton"
          class="attachButton"
          type="button"
          title={t("composer.attachTitle")}
          disabled={busy}
          onClick={() => {
            onAttach?.();
            fileInputRef.current?.click();
          }}
        >
          ＋
        </button>
        <input
          ref={fileInputRef}
          id="fileInput"
          type="file"
          accept="image/*,video/*"
          multiple
          hidden
          onChange={(event) => {
            const inputEl = event.target as HTMLInputElement;
            if (inputEl.files?.length) onFilesDropped(inputEl.files);
            inputEl.value = "";
          }}
        />
        <div class="composerMain">
          <div id="pendingUploads" class="pendingUploads" hidden={!pendingUploads.length}>
            {pendingUploads.map((item, index) => {
              const label = item.asset?.label || item.file.name;
              const meta = item.status === "uploading"
                ? t("misc.uploading")
                : item.status === "error"
                  ? (item.error || t("errors.uploadFailedShort"))
                  : formatFileSize(item.size ?? item.file.size);
              const canPreview = item.status === "done" && item.previewUrl;
              return (
                <div key={`upload-${index}`} class={`uploadChip ${item.status}`}>
                  <span
                    class="uploadThumb"
                    {...(canPreview ? {
                      "data-media-src": item.previewUrl,
                      "data-media-type": item.kind,
                      "data-media-title": label,
                      "data-media-open": item.previewUrl,
                    } : {})}
                    onClick={(event) => {
                      if (!canPreview) return;
                      event.stopPropagation();
                      onOpenMedia({
                        src: item.previewUrl!,
                        type: item.kind,
                        title: label,
                        openUrl: item.previewUrl,
                      });
                    }}
                  >
                    {item.kind === "video" ? (
                      <span class="uploadVideoIcon">▶</span>
                    ) : (
                      <img src={item.previewUrl || ""} alt="" />
                    )}
                  </span>
                  <span class="uploadName">{label}</span>
                  <span class="uploadMeta">{meta}</span>
                  <button
                    type="button"
                    aria-label={t("misc.removeUpload", { label })}
                    onClick={() => onRemoveUpload(index)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
          <textarea
            id="input"
            rows={2}
            placeholder={t("composer.placeholder")}
            value={input}
            onInput={(event) => onInputChange((event.target as HTMLTextAreaElement).value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                (event.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
              }
            }}
          />
        </div>
        <button id="sendButton" type="submit" disabled={busy}>
          {streaming ? t("composer.generating") : uploading > 0 ? t("composer.uploading") : t("composer.send")}
        </button>
      </form>
      <div class="composerHint">{t("composer.hint")}</div>
    </section>
  );
}