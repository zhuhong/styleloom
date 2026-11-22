import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../lib/i18n";

export type PromptRequest = {
  title: string;
  initialValue: string;
  confirmLabel?: string;
  onConfirm: (value: string) => void | Promise<void>;
};

type PromptDialogProps = {
  request: PromptRequest | null;
  onClose: () => void;
};

/** 替代 window.prompt：与设置弹窗同一套暗色 dialog。 */
export function PromptDialog({ request, onClose }: PromptDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
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
    setValue(request.initialValue);
    setError("");
    setSaving(false);
    if (!dialog.open) dialog.showModal();
    queueMicrotask(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [request]);

  const close = () => {
    dialogRef.current?.close();
    onClose();
  };

  const submit = async (event: Event) => {
    event.preventDefault();
    if (!request || saving) return;
    const next = value.trim();
    if (!next) {
      setError(t("misc.promptEmpty"));
      return;
    }
    setSaving(true);
    try {
      await request.onConfirm(next);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      class="promptDialog"
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
        <label>
          <span class="srOnly">{request?.title || ""}</span>
          <input
            ref={inputRef}
            value={value}
            disabled={saving}
            onInput={event => setValue((event.target as HTMLInputElement).value)}
          />
        </label>
        {error ? <p class="inlineWarning error">{error}</p> : null}
        <div class="dialogActions">
          <button type="button" disabled={saving} onClick={close}>{t("misc.cancel")}</button>
          <button type="submit" class="primary" disabled={saving}>
            {request?.confirmLabel || t("misc.confirm")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
