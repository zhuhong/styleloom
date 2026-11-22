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
import { panelScopedTools } from "../lib/panelTools";
import { Markdown } from "./Markdown";

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
  /** 统一的拖拽入口：文件、从其它应用拖来的图片链接、data: 图片都走这里。 */
  onDropTransfer: (dataTransfer: DataTransfer) => void;
  onConfirmSubmit: (item: { id: string; shotId: string; title: string; durationSeconds?: number; force?: boolean }) => void;
  onConfirmDecline: (item: { id: string; shotId: string }) => void;
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

/** 距底部多少像素内仍视为「贴底」，才自动跟随新消息。 */
const STICK_BOTTOM_PX = 80;
/** 长对话默认只挂载最近 N 条，点「更早」再展开，避免 DOM 无限涨。 */
const CHAT_WINDOW = 48;

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
  onDropTransfer,
  onConfirmSubmit,
  onConfirmDecline,
}: ChatPaneProps) {
  const messagesRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stickBottomRef = useRef(true);
  const [dragging, setDragging] = useState(false);
  const [showJumpLatest, setShowJumpLatest] = useState(false);
  const [showAllHistory, setShowAllHistory] = useState(false);

  const busy = streaming || uploading > 0;
  const hiddenCount = showAllHistory || items.length <= CHAT_WINDOW
    ? 0
    : items.length - CHAT_WINDOW;
  const visibleItems = hiddenCount > 0 ? items.slice(hiddenCount) : items;

  useEffect(() => {
    // 切项目 / 历史重置时收起展开态。
    setShowAllHistory(false);
  }, [projectId]);

  const syncStickState = () => {
    const el = messagesRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const stuck = distance <= STICK_BOTTOM_PX;
    stickBottomRef.current = stuck;
    setShowJumpLatest(!stuck && items.length > 0);
  };

  const jumpToLatest = () => {
    const el = messagesRef.current;
    if (!el) return;
    stickBottomRef.current = true;
    setShowJumpLatest(false);
    el.scrollTop = el.scrollHeight;
  };

  useEffect(() => {
    if (!stickBottomRef.current) {
      setShowJumpLatest(items.length > 0);
      return;
    }
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
      <div class="messagesWrap">
      <div
        id="messages"
        ref={messagesRef}
        class="messages"
        onClick={handleMessagesClick}
        onScroll={syncStickState}
      >
        {!items.length ? <EmptyChat /> : null}
        {hiddenCount > 0 ? (
          <button
            type="button"
            class="loadEarlier"
            onClick={() => setShowAllHistory(true)}
          >
            {t("chat.loadEarlier", { count: hiddenCount })}
          </button>
        ) : null}
        {visibleItems.map((item) => {
          if (item.kind === "confirm") {
            const settled = item.status !== "pending";
            return (
              <div key={item.id} class="confirmCard" data-status={item.status}>
                <div class="confirmHead">
                  {t("chat.confirmTitle")}
                  <span class="confirmShot">{item.shotId}</span>
                </div>
                <div class="confirmBody">{item.title}</div>
                <div class="confirmMeta">
                  {t("chat.confirmCost", { duration: item.durationSeconds ? `${item.durationSeconds}s` : t("chat.confirmDurationUnknown") })}
                </div>
                {item.force ? <div class="confirmWarn">{t("chat.confirmForce")}</div> : null}
                {settled ? (
                  <div class="confirmSettled">
                    {item.status === "submitted" ? t("chat.confirmSubmitted") : t("chat.confirmDeclinedShort")}
                  </div>
                ) : (
                  <div class="confirmActions">
                    <button type="button" class="confirmPrimary" disabled={busy} onClick={() => onConfirmSubmit(item)}>
                      {t("chat.confirmSubmit")}
                    </button>
                    <button type="button" class="confirmSecondary" onClick={() => onConfirmDecline(item)}>
                      {t("chat.confirmCancel")}
                    </button>
                  </div>
                )}
              </div>
            );
          }
          if (item.kind === "bubble") {
            // 流式中用纯文本，避免每个 delta 都重跑 Markdown；结束后再排版。
            const isMarkdown = item.role === "assistant" && !item.isError && !item.streaming;
            const className = `bubble ${item.isError ? "error" : item.role}${isMarkdown ? " markdown" : ""}${item.streaming ? " streaming" : ""}`;
            return (
              <div key={item.id} class={className}>
                {isMarkdown ? (
                  <Markdown content={item.content} projectId={projectId ?? undefined} />
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
      {showJumpLatest ? (
        <button type="button" class="jumpLatest" onClick={jumpToLatest}>
          {t("chat.jumpLatest")}
        </button>
      ) : null}
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
          // 交给窗口级的统一入口处理（它同时支持文件与「从其它应用拖来的链接/HTML」）
          event.preventDefault();
          event.stopPropagation();
          setDragging(false);
          if (event.dataTransfer) onDropTransfer(event.dataTransfer);
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
              const label = item.asset?.label || item.file?.name || t("misc.uploading");
              const meta = item.status === "uploading"
                ? t("misc.uploading")
                : item.status === "error"
                  ? (item.error || t("errors.uploadFailedShort"))
                  : formatFileSize(item.size ?? item.file?.size ?? 0);
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