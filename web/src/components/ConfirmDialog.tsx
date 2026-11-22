import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../lib/i18n";

export type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
};

type ConfirmDialogProps = {
  request: ConfirmRequest | null;
  onClose: () => void;
};

/** 替代 window.confirm：危险操作（删项目等）用统一暗色弹窗。 */
export function ConfirmDialog({ request, onClose }: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!request) {
      if (dialog.open) dialog.close();
      setSaving(false);
      setError("");
      return;
    }
    setSaving(false);
    setError("");
    if (!dialog.open) dialog.showModal();
    queueMicrotask(() => confirmRef.current?.focus());
  }, [request]);

  const close = () => {
    dialogRef.current?.close();
    onClose();
  };

  const submit = async (event: Event) => {
    event.preventDefault();
    if (!request || saving) return;
    setSaving(true);
    try {
      await request.onConfirm();
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      class="promptDialog confirmDialog"
      onCancel={event => {
        event.preventDefault();
        if (!saving) close();
      }}
      onClick={event => {
        if (event.target === dialogRef.current && !saving) close();
      }}
    >
      <form onSubmit={event => void submit(event)}>
        <h2>{request?.title || ""}</h2>
        <p class="confirmMessage">{request?.message || ""}</p>
        {error ? <p class="inlineWarning error">{error}</p> : null}
        <div class="dialogActions">
          <button type="button" disabled={saving} onClick={close}>{t("misc.cancel")}</button>
          <button
            ref={confirmRef}
            type="submit"
            class={request?.danger ? "danger" : "primary"}
            disabled={saving}
          >
            {request?.confirmLabel || t("misc.confirm")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
