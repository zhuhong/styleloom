import { useEffect, useRef, useState } from "preact/hooks";
import type { AppSettings } from "../lib/types";
import { getDeep, setDeep } from "../lib/utils";
import { t } from "../lib/i18n";

type SettingsDialogProps = {
  open: boolean;
  settings: AppSettings | null;
  onClose: () => void;
  onSave: (next: AppSettings) => Promise<void>;
};

type SettingField = {
  path: string;
  labelKey: string;
  type?: "password" | "text";
  placeholderKey?: string;
  placeholder?: string;
};

const settingSections: { titleKey: string; hintKey?: string; htmlHint?: boolean; fields: SettingField[] }[] = [
  {
    titleKey: "settings.llmSection",
    fields: [
      { path: "llm.baseUrl", labelKey: "settings.baseUrl", placeholder: "http://localhost:4000/v1" },
      { path: "llm.apiKey", labelKey: "settings.apiKey", type: "password", placeholderKey: "settings.keepSecret" },
      { path: "llm.model", labelKey: "settings.textModel", placeholder: "deepseek-v4.1-flash" },
      { path: "llm.visionModel", labelKey: "settings.visionModel", placeholder: "ag-gemini-3.8-flash" },
    ],
  },
  {
    titleKey: "settings.videoSection",
    hintKey: "settings.videoHint",
    htmlHint: true,
    fields: [
      { path: "video.provider", labelKey: "settings.videoProvider", placeholder: "icompify / local" },
      { path: "video.baseUrl", labelKey: "settings.baseUrl", placeholder: "https://api.icompify.com" },
      { path: "video.apiKey", labelKey: "settings.apiKey", type: "password", placeholderKey: "settings.keepSecret" },
      { path: "video.model", labelKey: "settings.textVideoModel" },
      { path: "video.referenceModel", labelKey: "settings.referenceModel" },
    ],
  },
  {
    titleKey: "settings.localVideoSection",
    hintKey: "settings.localVideoHint",
    htmlHint: true,
    fields: [
      { path: "video.local.baseUrl", labelKey: "settings.gatewayUrl", placeholder: "http://127.0.0.1:8000" },
      { path: "video.local.token", labelKey: "settings.gatewayToken", type: "password", placeholderKey: "settings.keepSecret" },
      { path: "video.local.shortEdge", labelKey: "settings.shortEdge", placeholder: "480" },
    ],
  },
  {
    titleKey: "settings.xhsSection",
    hintKey: "settings.xhsHint",
    fields: [
      { path: "xhs.ytDlpPath", labelKey: "settings.ytdlpPath", placeholder: "yt-dlp" },
      { path: "xhs.cookiesFromBrowser", labelKey: "settings.browserCookie", placeholderKey: "settings.placeholderBrowser" },
      { path: "xhs.referer", labelKey: "settings.referer", placeholder: "https://www.xiaohongshu.com" },
    ],
  },
  {
    titleKey: "settings.imageSection",
    hintKey: "settings.imageHint",
    htmlHint: true,
    fields: [
      { path: "image.api", labelKey: "settings.imageApi", placeholder: "auto / local / openrouter / openai" },
      { path: "image.baseUrl", labelKey: "settings.baseUrl", placeholderKey: "settings.placeholderImageBaseUrl" },
      { path: "image.apiKey", labelKey: "settings.apiKey", type: "password" },
      { path: "image.model", labelKey: "settings.model", placeholderKey: "settings.placeholderImageModel" },
      { path: "image.size", labelKey: "settings.size", placeholderKey: "settings.placeholderImageSize" },
    ],
  },
  {
    titleKey: "settings.localImageSection",
    hintKey: "settings.localImageHint",
    htmlHint: true,
    fields: [
      { path: "image.local.mode", labelKey: "settings.connectMode", placeholder: "auto / direct / ssh" },
      { path: "image.local.host", labelKey: "settings.sshHost", placeholderKey: "settings.placeholderSshHost" },
      { path: "image.local.sshBin", labelKey: "settings.sshBin", placeholder: "ssh" },
      { path: "image.local.scpBin", labelKey: "settings.scpBin", placeholder: "scp" },
      { path: "image.local.pythonBin", labelKey: "settings.pythonBin", placeholder: "/path/to/python" },
      { path: "image.local.script", labelKey: "settings.scriptPath", placeholder: "/path/to/generate.py" },
      { path: "image.local.workdir", labelKey: "settings.workdir", placeholder: "/path/to/workdir" },
      { path: "image.local.shortEdge", labelKey: "settings.shortEdge", placeholder: "768" },
      { path: "image.local.steps", labelKey: "settings.steps", placeholder: "8" },
      { path: "image.local.vram", labelKey: "settings.vramMode", placeholder: "offload / auto / cuda" },
      { path: "image.local.timeoutMs", labelKey: "settings.timeoutMs", placeholder: "900000" },
    ],
  },
];

export function SettingsDialog({ open, settings, onClose, onSave }: SettingsDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (settings) setDraft(structuredClone(settings));
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open, settings]);

  const fieldValue = (path: string) => {
    const value = getDeep(draft, path);
    return value == null ? "" : String(value);
  };

  const updateField = (path: string, value: string) => {
    setDraft((current) => {
      if (!current) return current;
      const next = structuredClone(current) as Record<string, unknown>;
      setDeep(next, path, value);
      return next as AppSettings;
    });
  };

  const handleSubmit = async (event: Event) => {
    event.preventDefault();
    const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null;
    if (!submitter || submitter.value !== "save") {
      onClose();
      return;
    }
    if (!draft) return;
    setSaving(true);
    try {
      const next = structuredClone(draft) as Record<string, unknown>;
      for (const section of settingSections) {
        for (const field of section.fields) {
          const raw = getDeep(draft, field.path);
          setDeep(next, field.path, String(raw ?? "").trim());
        }
      }
      await onSave(next as AppSettings);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      class="settingsDialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <form method="dialog" id="settingsForm" onSubmit={handleSubmit}>
        <h2>{t("settings.title")}</h2>
        <p class="dialogHint" dangerouslySetInnerHTML={{ __html: t("settings.secretsHint") }} />
        {settingSections.map((section) => (
          <section key={section.titleKey}>
            <h3>{t(section.titleKey)}</h3>
            {section.fields.map((field) => (
              <label key={field.path}>
                <span>{t(field.labelKey)}</span>
                <input
                  name={field.path}
                  type={field.type || "text"}
                  value={fieldValue(field.path)}
                  placeholder={field.placeholderKey ? t(field.placeholderKey) : field.placeholder}
                  onInput={(event) => updateField(field.path, (event.target as HTMLInputElement).value)}
                />
              </label>
            ))}
            {section.hintKey ? (
              section.htmlHint ? (
                <p class="dialogHint" dangerouslySetInnerHTML={{ __html: t(section.hintKey) }} />
              ) : (
                <p class="dialogHint">{t(section.hintKey)}</p>
              )
            ) : null}
          </section>
        ))}
        <div class="dialogActions">
          <button value="cancel" class="ghost" type="submit" disabled={saving}>
            {t("misc.cancel")}
          </button>
          <button value="save" id="saveSettings" class="primary" type="submit" disabled={saving || !draft}>
            {t("misc.save")}
          </button>
        </div>
      </form>
    </dialog>
  );
}