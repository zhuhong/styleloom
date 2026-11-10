import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { dataDir, loadSettings, type Settings } from "../../config";
import { ensureDir, exists, stamp } from "../../util/fs";
import { probeMedia } from "../../util/ffmpeg";

export type XhsDownloadResult = {
  path: string;
  title: string;
  noteId?: string;
  sourceUrl: string;
  originalUrl: string;
  duration?: number;
  width?: number;
  height?: number;
  warning?: string;
};

export type XhsDownloadOptions = {
  url: string;
  signal?: AbortSignal;
  onProgress?: (percent: number, label: string) => void;
};

const urlPattern = /https?:\/\/[^\s<>"'，。；、）)】]+/gi;
const metaPrefix = "VIDEOCOPY_META\t";

export function extractUrlFromText(text: string) {
  const match = text.match(urlPattern)?.[0];
  return match?.replace(/[.,;!?]+$/, "");
}

export function isXhsUrl(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "xhslink.com" || host === "www.xhslink.com" || host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com");
  } catch {
    return false;
  }
}

function hasXsecToken(url: string) {
  try {
    const token = new URL(url).searchParams.get("xsec_token");
    return Boolean(token && token.trim());
  } catch {
    return false;
  }
}

function noteIdFromUrl(url: string) {
  try {
    const match = new URL(url).pathname.match(/\/(?:explore|discovery\/item|item)\/([\da-f]{8,})/i);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function isShortLink(url: string) {
  try {
    return new URL(url).hostname.toLowerCase().endsWith("xhslink.com");
  } catch {
    return false;
  }
}

/** xhslink 短链里没有 xsec_token，先跟随跳转拿到完整笔记地址。 */
async function expandShortLink(url: string, settings: Settings, signal?: AbortSignal) {
  if (!isShortLink(url)) return { url, warning: hasXsecToken(url) ? undefined : "链接不含 xsec_token，可能无法下载；请在浏览器打开笔记后复制地址栏完整 URL" };
  const timeout = AbortSignal.timeout(20_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(url, {
    headers: { Referer: settings.xhs.referer, "User-Agent": settings.xhs.userAgent },
    redirect: "follow",
    signal: combined,
  });
  let finalUrl = response.url;
  let text = "";
  try {
    text = (await response.text()).slice(0, 400_000);
  } catch {
    // 忽略正文读取失败，优先使用最终 URL
  }
  if (isShortLink(finalUrl)) {
    const location = text.match(/location\.(?:replace|href)\s*=\s*["']([^"']+)/i)?.[1]
      ?? text.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+url=([^"'>\s]+)/i)?.[1];
    if (location) {
      try {
        finalUrl = new URL(location.replaceAll("&amp;", "&"), finalUrl).toString();
      } catch {
        // 保留原 URL
      }
    }
  }
  if (isShortLink(finalUrl)) throw new Error("短链展开失败：请在浏览器打开笔记后，复制地址栏里带 xsec_token 的完整 URL");
  return { url: finalUrl, warning: hasXsecToken(finalUrl) ? undefined : "展开后的链接不含 xsec_token，可能需要登录态；若下载失败请改用浏览器地址栏完整 URL" };
}

function buildArgs(ytDlpPath: string, url: string, outputDir: string, settings: Settings) {
  const args = [
    ytDlpPath,
    url,
    "--no-playlist",
    "--newline",
    "--progress",
    "--socket-timeout", "30",
    "--retries", "3",
    "--referer", settings.xhs.referer,
    "--user-agent", settings.xhs.userAgent,
    "--format", "bv*+ba/b",
    "--merge-output-format", "mp4",
    "--no-simulate",
    "--print", `after_move:${metaPrefix}%(title)s\t%(id)s\t%(filepath)s`,
    "-o", join(outputDir, "%(id)s.%(ext)s"),
  ];
  if (settings.xhs.cookiesFromBrowser.trim()) {
    args.splice(1, 0, "--cookies-from-browser", settings.xhs.cookiesFromBrowser.trim());
  }
  return args;
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      onLine(buffer.slice(0, index).replace(/\r$/, ""));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) onLine(buffer);
}

async function newestMediaFile(directory: string): Promise<string | undefined> {
  if (!(await exists(directory))) return undefined;
  const entries = await readdir(directory, { withFileTypes: true });
  const candidates: { path: string; mtime: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(mp4|mkv|webm|mov|m4v)$/i.test(entry.name)) continue;
    const path = join(directory, entry.name);
    candidates.push({ path, mtime: (await stat(path)).mtimeMs });
  }
  return candidates.sort((left, right) => right.mtime - left.mtime)[0]?.path;
}

function failureMessage(stderr: string, url: string, settings: Settings) {
  const tail = stderr.trim().split("\n").slice(-12).join("\n");
  const hints: string[] = [];
  if (/xsec_token|unsupported url|no video|unable to extract/i.test(stderr)) {
    hints.push("请使用浏览器地址栏中带 xsec_token 的完整笔记 URL（不要用 xhslink.com 短链）");
  }
  if (/cookie|login|sign in|log in|登录/i.test(stderr)) {
    hints.push(`请在 ${settings.xhs.cookiesFromBrowser || "浏览器"} 里登录小红书；Safari 需要给终端完全磁盘访问权限`);
  }
  if (/ENOENT|not found|no such file/i.test(stderr)) hints.push("未找到 yt-dlp，请先执行 brew install yt-dlp");
  if (/private|仅自己可见|该笔记/i.test(stderr)) hints.push("笔记可能是私密/已删除/地区限制");
  return `小红书视频下载失败：${tail || "yt-dlp 未返回错误信息"}${hints.length ? `\n建议：${hints.join("；")}` : ""}`;
}

/** 下载小红书笔记视频：展开短链 → yt-dlp（浏览器 Cookie + Referer + UA）→ ffprobe 校验。 */
export async function downloadXhsVideo(options: XhsDownloadOptions): Promise<XhsDownloadResult> {
  const settings = await loadSettings();
  const input = options.url.trim();
  if (!input) throw new Error("请提供小红书笔记链接");
  if (!settings.xhs.ytDlpPath.trim()) throw new Error("未配置 yt-dlp 路径");
  const expanded = await expandShortLink(input, settings, options.signal);
  if (!isXhsUrl(expanded.url)) throw new Error(`不是小红书链接：${expanded.url}`);
  if (!hasXsecToken(expanded.url)) {
    // 仍然尝试下载；很多旧链接没有 token 也能拿到，失败时错误信息会提示换完整 URL。
    options.onProgress?.(2, "链接缺少 xsec_token，继续尝试");
  }
  const noteId = noteIdFromUrl(expanded.url);
  const outputDir = join(dataDir, "cache", "xhs", `${noteId ?? "note"}-${stamp()}`);
  await ensureDir(outputDir);

  const args = buildArgs(settings.xhs.ytDlpPath.trim(), expanded.url, outputDir, settings);
  options.onProgress?.(5, "启动 yt-dlp");
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT|not found/i.test(message)) throw new Error("未找到 yt-dlp，请先执行 brew install yt-dlp");
    throw error;
  }

  let stderrTail = "";
  let meta: { title?: string; id?: string; filepath?: string } = {};
  let percent = 5;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, settings.xhs.timeoutMs);
  const abort = () => proc.kill();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const stdoutTask = readLines(proc.stdout as ReadableStream<Uint8Array>, line => {
      if (line.startsWith(metaPrefix)) {
        const [title, id, filepath] = line.slice(metaPrefix.length).split("\t");
        meta = { title, id, filepath };
        return;
      }
      const match = line.match(/(\d+(?:\.\d+)?)%/);
      if (match) {
        const value = Math.min(95, Math.max(percent, Number(match[1])));
        if (value > percent) {
          percent = value;
          options.onProgress?.(value, `下载中 ${value}%`);
        }
      } else if (/\[info\]|\[xiaohongshu\]/i.test(line)) {
        options.onProgress?.(percent, line.slice(0, 120));
      }
    });
    const stderrTask = readLines(proc.stderr as ReadableStream<Uint8Array>, line => {
      if (!line.trim()) return;
      stderrTail = `${stderrTail}\n${line}`.split("\n").slice(-40).join("\n");
      const match = line.match(/(\d+(?:\.\d+)?)%/);
      if (match) {
        const value = Math.min(95, Math.max(percent, Number(match[1])));
        if (value > percent) {
          percent = value;
          options.onProgress?.(value, `下载中 ${value}%`);
        }
      }
    });
    const [code] = await Promise.all([proc.exited, stdoutTask, stderrTask]);
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("下载已取消");
    if (timedOut) throw new Error(`小红书视频下载超时（${Math.round(settings.xhs.timeoutMs / 1000)} 秒），请检查网络或调大 xhs.timeoutMs`);
    if (code !== 0) throw new Error(failureMessage(stderrTail, expanded.url, settings));
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }

  options.onProgress?.(97, "校验视频");
  let path = meta.filepath?.trim();
  if (!path || !(await exists(path))) path = await newestMediaFile(outputDir);
  if (!path) throw new Error(`yt-dlp 执行成功但没有找到视频文件，请查看：${outputDir}`);
  if (!/\.(mp4|mkv|webm|mov|m4v)$/i.test(path)) throw new Error("该笔记没有视频文件（可能是图文笔记）");
  const info = await probeMedia(path, options.signal).catch(() => undefined);
  if (!info?.width || !info?.duration) throw new Error("下载的文件无法识别为视频，请确认笔记包含视频且不是封面图");
  options.onProgress?.(100, "下载完成");
  return {
    path,
    title: meta.title?.trim() || noteId || "小红书视频",
    noteId,
    sourceUrl: expanded.url,
    originalUrl: input,
    duration: info?.duration,
    width: info?.width,
    height: info?.height,
    warning: expanded.warning,
  };
}
