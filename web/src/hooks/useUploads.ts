import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { t } from "../lib/i18n";
import type { PendingUpload, Project } from "../lib/types";
import { fileUrl, isUploadableFile, mediaTypeForPath } from "../lib/utils";

/**
 * 从拖拽载荷里提取图片地址。
 * Finder/照片拖是 files；浏览器或图片应用拖常常只有 text/uri-list 或 <img src> HTML。
 */
function collectImageSources(dataTransfer: DataTransfer) {
  const urls: string[] = [];
  const add = (value: string | null | undefined) => {
    const trimmed = (value ?? "").trim();
    if (/^https?:\/\//i.test(trimmed)) urls.push(trimmed);
  };
  add(dataTransfer.getData("text/uri-list"));
  add(dataTransfer.getData("text/plain"));
  const html = dataTransfer.getData("text/html");
  if (html) {
    for (const match of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) add(match[1]);
  }
  return [...new Set(urls)].slice(0, 6);
}

type UseUploadsOptions = {
  getProjectId: () => string | null;
  onError: (message: string) => void;
  onUploaded: () => void;
};

export function useUploads({ getProjectId, onError, onUploaded }: UseUploadsOptions) {
  const [uploading, setUploading] = useState(0);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const dragDepthRef = useRef(0);

  const clearPendingUploads = useCallback(() => {
    setPendingUploads(current => {
      for (const entry of current) {
        if (entry.previewUrl.startsWith("blob:")) URL.revokeObjectURL(entry.previewUrl);
      }
      return [];
    });
    setUploading(0);
  }, []);

  const removeUpload = useCallback((index: number) => {
    setPendingUploads(current => {
      const next = current.slice();
      const [entry] = next.splice(index, 1);
      if (entry?.previewUrl.startsWith("blob:")) URL.revokeObjectURL(entry.previewUrl);
      return next;
    });
  }, []);

  const uploadFiles = useCallback(async (fileList: FileList | File[]) => {
    const projectId = getProjectId();
    if (!projectId) {
      onError(t("errors.needProjectForUpload"));
      return;
    }
    const files = [...fileList].filter(isUploadableFile);
    if (!files.length) {
      onError(t("errors.onlyMedia"));
      return;
    }
    let blocked = false;
    setPendingUploads(currentUploads => {
      if (currentUploads.length + files.length > 6) {
        blocked = true;
        return currentUploads;
      }
      return currentUploads;
    });
    if (blocked) {
      onError(t("errors.tooManyUploads", { max: 6 }));
      return;
    }

    const entries: PendingUpload[] = files.map(file => ({
      file,
      kind: file.type.startsWith("video/") || /\.(mp4|mov|webm|m4v)$/i.test(file.name) ? "video" : "image",
      previewUrl: URL.createObjectURL(file),
      status: "uploading",
    }));
    setPendingUploads(currentUploads => [...currentUploads, ...entries]);
    setUploading(value => value + entries.length);

    const form = new FormData();
    for (const [index, entry] of entries.entries()) {
      const file = files[index];
      if (file) form.append("files", file, file.name);
    }
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/uploads`, { method: "POST", body: form });
      const data = await response.json().catch(() => ({})) as { assets?: Project["assets"]; error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const assets = Array.isArray(data.assets) ? data.assets : [];
      setPendingUploads(currentUploads => currentUploads.map(entry => {
        const index = entries.indexOf(entry);
        if (index < 0) return entry;
        const asset = assets[index];
        if (!asset) return { ...entry, status: "error", error: t("errors.noAssetReturned") };
        if (entry.previewUrl.startsWith("blob:")) URL.revokeObjectURL(entry.previewUrl);
        return {
          ...entry,
          asset,
          kind: mediaTypeForPath(asset.path) === "video" ? "video" : "image",
          mimeType: typeof asset.meta?.mimeType === "string" ? asset.meta.mimeType : undefined,
          size: typeof asset.meta?.size === "number" ? asset.meta.size : undefined,
          status: "done",
          previewUrl: fileUrl(projectId, asset.path),
        };
      }));
      onUploaded();
    } catch (error) {
      setPendingUploads(currentUploads => currentUploads.map(entry => (
        entries.includes(entry) ? { ...entry, status: "error", error: (error as Error).message } : entry
      )));
      onError(t("errors.uploadFailed", { message: (error as Error).message }));
    } finally {
      setUploading(value => Math.max(0, value - entries.length));
    }
  }, [getProjectId, onError, onUploaded]);

  const uploadUrls = useCallback(async (urls: string[]) => {
    const projectId = getProjectId();
    if (!projectId) {
      onError(t("errors.needProjectForUpload"));
      return;
    }
    const unique = [...new Set(urls.map(url => url.trim()).filter(Boolean))];
    if (!unique.length) return;
    let blocked = false;
    setPendingUploads(currentUploads => {
      if (currentUploads.length + unique.length > 6) blocked = true;
      return currentUploads;
    });
    if (blocked) {
      onError(t("errors.tooManyUploads", { max: 6 }));
      return;
    }

    const entries: PendingUpload[] = unique.map(url => ({
      kind: "image",
      previewUrl: "",
      status: "uploading",
      sourceUrl: url,
    }));
    setPendingUploads(currentUploads => [...currentUploads, ...entries]);
    setUploading(value => value + entries.length);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/uploads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: unique }),
      });
      const data = await response.json().catch(() => ({})) as { assets?: Project["assets"]; errors?: string[]; error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const assets = Array.isArray(data.assets) ? data.assets : [];
      const failures = Array.isArray(data.errors) ? data.errors : [];
      setPendingUploads(currentUploads => currentUploads.map(entry => {
        const index = entries.indexOf(entry);
        if (index < 0) return entry;
        const asset = assets[index];
        if (!asset) {
          return { ...entry, status: "error", error: failures[0] || t("errors.noAssetReturned") };
        }
        return {
          ...entry,
          asset,
          kind: mediaTypeForPath(asset.path) === "video" ? "video" : "image",
          mimeType: typeof asset.meta?.mimeType === "string" ? asset.meta.mimeType : undefined,
          size: typeof asset.meta?.size === "number" ? asset.meta.size : undefined,
          status: "done",
          previewUrl: fileUrl(projectId, asset.path),
        };
      }));
      onUploaded();
    } catch (error) {
      setPendingUploads(currentUploads => currentUploads.map(entry => (
        entries.includes(entry) ? { ...entry, status: "error", error: (error as Error).message } : entry
      )));
      onError(t("errors.uploadFailed", { message: (error as Error).message }));
    } finally {
      setUploading(value => Math.max(0, value - entries.length));
    }
  }, [getProjectId, onError, onUploaded]);

  const handleDropTransfer = useCallback((dataTransfer: DataTransfer | null) => {
    if (!dataTransfer) return;
    const files = [...(dataTransfer.files ?? [])].filter(isUploadableFile);
    if (files.length) {
      void uploadFiles(files);
      return;
    }
    const urls = collectImageSources(dataTransfer);
    if (urls.length) {
      void uploadUrls(urls);
      return;
    }
    onError(t("errors.unsupportedDrop"));
  }, [onError, uploadFiles, uploadUrls]);

  useEffect(() => {
    const onDragEnter = (event: DragEvent) => {
      if (!event.dataTransfer) return;
      dragDepthRef.current += 1;
      if (!getProjectId()) return;
      event.preventDefault();
      setDragActive(true);
    };
    const onDragOver = (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = getProjectId() ? "copy" : "none";
    };
    const onDragLeave = () => {
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (!dragDepthRef.current) setDragActive(false);
    };
    const onDrop = (event: DragEvent) => {
      const handledByChild = event.defaultPrevented;
      event.preventDefault();
      dragDepthRef.current = 0;
      setDragActive(false);
      if (handledByChild) return;
      handleDropTransfer(event.dataTransfer);
    };
    const onPaste = (event: ClipboardEvent) => {
      const files = [...(event.clipboardData?.files ?? [])].filter(isUploadableFile);
      if (!files.length) return;
      event.preventDefault();
      void uploadFiles(files);
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    document.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      document.removeEventListener("paste", onPaste);
    };
  }, [getProjectId, handleDropTransfer, uploadFiles]);

  return {
    uploading,
    pendingUploads,
    dragActive,
    uploadFiles,
    handleDropTransfer,
    clearPendingUploads,
    removeUpload,
  };
}
