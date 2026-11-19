import { langLocale, t } from "./i18n";

export function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

export function fileUrl(projectId: string | undefined, path: string | undefined) {
  if (!projectId || !path) return "";
  return `/files/${encodeURIComponent(projectId)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function skillFileUrl(skillId: string | undefined, path: string | undefined) {
  if (!skillId || !path) return "";
  return `/skill-files/${encodeURIComponent(skillId)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function mediaTypeForPath(path: string | undefined) {
  const extension = String(path ?? "").split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  if (["mp4", "webm", "mov", "m4v", "ogv"].includes(extension)) return "video";
  if (["mp3", "m4a", "wav", "aac", "ogg", "flac"].includes(extension)) return "audio";
  if (["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp", "svg"].includes(extension)) return "image";
  return null;
}

export function formatSeconds(value: unknown) {
  const number = Number(value ?? 0);
  return `${number.toFixed(number % 1 === 0 ? 0 : 2)}s`;
}

export function formatUpdatedAt(value: unknown) {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString(langLocale(), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function formatDuration(ms: unknown) {
  const total = Math.max(0, Number(ms) || 0);
  if (total < 1) return "<1ms";
  if (total < 1000) return `${Math.round(total)}ms`;
  const seconds = total / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatFileSize(bytes: unknown) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / 1024 / 1024).toFixed(1)}MB`;
}

export function formatElapsed(iso: string | undefined) {
  const started = Date.parse(iso || "");
  if (!Number.isFinite(started)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function labelOr(key: string, fallback: string) {
  const value = t(key);
  return value === key ? fallback : value;
}

export function toolLabel(name: string) {
  return labelOr(`tool.${name}`, name);
}

export function stageLabel(stage: string) {
  return labelOr(`stage.${stage}`, stage);
}

export function learningLabel(status: string) {
  return labelOr(`learningStatus.${status}`, status);
}

export function skillStatusLabel(status: string) {
  return labelOr(`skillStatus.${status}`, status);
}

export function skillKindLabel(kind: string) {
  return labelOr(`skillKind.${kind}`, kind);
}

export function skillSurfaceLabel(surface: string) {
  return labelOr(`skillSurface.${surface}`, surface);
}

export function shotStatusLabel(status: string) {
  return labelOr(`shotStatus.${status}`, status);
}

export function jobStatusLabel(status: string) {
  return labelOr(`jobs.status.${status}`, status);
}

export function learningStateLabel(learning: { status: string; warning?: string }) {
  if (learning.status === "done" && learning.warning) return t("learning.doneWithWarning");
  return learningLabel(learning.status);
}

export function readableLearningWarning(warning: string | undefined) {
  if (!warning) return "";
  if (warning.includes("返回内容不是 JSON")) return t("learning.fallbackWarning");
  return warning;
}

export function setDeep(target: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split(".");
  let current: Record<string, unknown> = target;
  for (const key of keys.slice(0, -1)) {
    const next = current[key];
    if (!next || typeof next !== "object") current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[keys.at(-1)!] = value;
}

export function getDeep(target: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (value == null || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[key];
  }, target);
}

export function isUploadableFile(file: File) {
  return file.type.startsWith("image/") || file.type.startsWith("video/")
    || /\.(jpe?g|png|webp|gif|avif|bmp|mp4|mov|webm|m4v)$/i.test(file.name);
}

export function uid(prefix = "id") {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}
