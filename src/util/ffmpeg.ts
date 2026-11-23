import { loadSettings } from "../config";

export type MediaInfo = {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  videoCodec: string;
  audioCodec: string;
};

export type ProcessResult = { stdout: string; stderr: string; code: number };

export async function runProcess(command: string[], options: { cwd?: string; signal?: AbortSignal } = {}): Promise<ProcessResult> {
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("已取消");
  const proc = Bun.spawn(command, { cwd: options.cwd, stdout: "pipe", stderr: "pipe" });
  const abort = () => proc.kill();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("已取消");
    return { stdout, stderr, code };
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

async function runTool(bin: string, args: string[], options: { signal?: AbortSignal } = {}) {
  const result = await runProcess([bin, "-hide_banner", "-nostdin", ...args], options);
  if (result.code !== 0) {
    const message = result.stderr.trim().split("\n").slice(-6).join("\n");
    throw new Error(`${bin} 执行失败（退出码 ${result.code}）：${message || "无错误输出"}`);
  }
  return result;
}

/** 用配置里的 ffmpeg 执行一次转码/合成，失败时保留最后几行 stderr。 */
export async function runFfmpeg(args: string[], options: { signal?: AbortSignal } = {}) {
  const settings = await loadSettings();
  return runTool(settings.ffmpeg.ffmpegPath, args, options);
}

export async function probeMedia(path: string, signal?: AbortSignal): Promise<MediaInfo> {
  const settings = await loadSettings();
  const result = await runProcess([
    settings.ffmpeg.ffprobePath,
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    path,
  ], { signal });
  if (result.code !== 0) throw new Error(`无法读取媒体信息：${result.stderr.trim().slice(-500)}`);
  const data = JSON.parse(result.stdout) as {
    format?: { duration?: string };
    streams?: {
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      avg_frame_rate?: string;
      duration?: string;
    }[];
  };
  const streams = data.streams ?? [];
  const video = streams.find(stream => stream.codec_type === "video");
  const audio = streams.find(stream => stream.codec_type === "audio");
  const rate = video?.r_frame_rate ?? video?.avg_frame_rate ?? "24/1";
  const [numerator, denominator] = rate.split("/").map(Number);
  const fps = denominator ? numerator / denominator : 24;
  const duration = Number(data.format?.duration ?? video?.duration ?? 0);
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 24,
    hasAudio: Boolean(audio),
    videoCodec: video?.codec_name ?? "",
    audioCodec: audio?.codec_name ?? "",
  };
}

/** 解析 `select='gt(scene,TH)',metadata=print:file=-` 的 stdout。 */
export function parseSceneCuts(stdout: string) {
  const cuts: { time: number; score: number }[] = [];
  let pendingTime: number | undefined;
  for (const line of stdout.split("\n")) {
    const timeMatch = line.match(/pts_time:([-\d.]+)/);
    if (timeMatch) {
      pendingTime = Number(timeMatch[1]);
      continue;
    }
    const scoreMatch = line.match(/lavfi\.scene_score=([\d.]+)/);
    if (scoreMatch && pendingTime !== undefined) {
      const score = Number(scoreMatch[1]);
      if (Number.isFinite(pendingTime) && pendingTime > 0) cuts.push({ time: pendingTime, score });
      pendingTime = undefined;
    }
  }
  return cuts;
}

export async function detectCuts(path: string, threshold: number, signal?: AbortSignal) {
  const settings = await loadSettings();
  const result = await runTool(settings.ffmpeg.ffmpegPath, [
    "-nostats",
    "-i", path,
    "-an",
    "-vf", `select='gt(scene,${threshold})',metadata=print:file=-`,
    "-f", "null",
    "-",
  ], { signal });
  return parseSceneCuts(result.stdout);
}

export async function extractFrame(path: string, time: number, output: string, width = 960, signal?: AbortSignal) {
  const settings = await loadSettings();
  await runTool(settings.ffmpeg.ffmpegPath, [
    "-y",
    "-ss", Math.max(0, time).toFixed(3),
    "-i", path,
    "-frames:v", "1",
    "-vf", `scale=${width}:-2`,
    "-q:v", "3",
    output,
  ], { signal });
}

export async function extractClip(path: string, start: number, duration: number, output: string, signal?: AbortSignal) {
  const settings = await loadSettings();
  await runTool(settings.ffmpeg.ffmpegPath, [
    "-y",
    "-ss", Math.max(0, start).toFixed(3),
    "-i", path,
    "-t", Math.max(0.1, duration).toFixed(3),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "24",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    output,
  ], { signal });
}

export async function extractAudio(path: string, output: string, signal?: AbortSignal) {
  const settings = await loadSettings();
  await runTool(settings.ffmpeg.ffmpegPath, [
    "-y",
    "-i", path,
    "-vn",
    "-c:a", "aac",
    "-b:a", "160k",
    output,
  ], { signal });
}

async function runFfmpegRawRgb(args: string[], expectedBytes: number, signal?: AbortSignal) {
  const settings = await loadSettings();
  if (signal?.aborted) throw signal.reason ?? new Error("已取消");
  const proc = Bun.spawn([settings.ffmpeg.ffmpegPath, "-hide_banner", "-nostdin", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const abort = () => proc.kill();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const [buffer, stderr, code] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (signal?.aborted) throw signal.reason ?? new Error("已取消");
    if (code !== 0) {
      const message = stderr.trim().split("\n").slice(-6).join("\n");
      throw new Error(`ffmpeg 执行失败（退出码 ${code}）：${message || "无错误输出"}`);
    }
    const rgb = new Uint8Array(buffer);
    if (rgb.byteLength < expectedBytes) {
      throw new Error(`ffmpeg 输出字节不足：期望 ${expectedBytes}，实际 ${rgb.byteLength}`);
    }
    return rgb.subarray(0, expectedBytes);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

/** 从已有图片抽 cols×rows 的 RGB 网格，避免再 seek 源片。 */
export async function sampleGridFromImage(path: string, cols: number, rows: number, signal?: AbortSignal) {
  const width = Math.max(1, Math.floor(cols));
  const height = Math.max(1, Math.floor(rows));
  const rgb = await runFfmpegRawRgb([
    "-y",
    "-i", path,
    "-frames:v", "1",
    "-vf", `scale=${width}:${height}:flags=area`,
    "-f", "rawvideo",
    "-pix_fmt", "rgb24",
    "-",
  ], width * height * 3, signal);
  return { rgb, width, height };
}

/** 从视频按时码抽 cols×rows RGB 网格（无关键帧时回退）。 */
export async function sampleGrid(path: string, time: number, cols: number, rows: number, signal?: AbortSignal) {
  const width = Math.max(1, Math.floor(cols));
  const height = Math.max(1, Math.floor(rows));
  const rgb = await runFfmpegRawRgb([
    "-y",
    "-ss", Math.max(0, time).toFixed(3),
    "-i", path,
    "-frames:v", "1",
    "-vf", `scale=${width}:${height}:flags=area`,
    "-f", "rawvideo",
    "-pix_fmt", "rgb24",
    "-",
  ], width * height * 3, signal);
  return { rgb, width, height };
}

/** 解析 silencedetect 的 silence_start / silence_end（通常在 stderr）。 */
export function parseSilence(stderr: string) {
  const segments: { start: number; end: number }[] = [];
  let pendingStart: number | undefined;
  for (const line of stderr.split("\n")) {
    const startMatch = line.match(/silence_start:\s*([-\d.]+)/);
    if (startMatch) {
      pendingStart = Number(startMatch[1]);
      continue;
    }
    const endMatch = line.match(/silence_end:\s*([-\d.]+)/);
    if (endMatch && pendingStart !== undefined) {
      const end = Number(endMatch[1]);
      if (Number.isFinite(pendingStart) && Number.isFinite(end) && end > pendingStart) {
        segments.push({ start: Number(pendingStart.toFixed(3)), end: Number(end.toFixed(3)) });
      }
      pendingStart = undefined;
    }
  }
  return segments;
}

export async function detectSilence(path: string, signal?: AbortSignal) {
  const settings = await loadSettings();
  // silencedetect 写到 stderr；exit 0 时仍可能只有静音日志。
  const result = await runProcess([
    settings.ffmpeg.ffmpegPath,
    "-hide_banner",
    "-nostdin",
    "-i", path,
    "-af", "silencedetect=noise=-30dB:d=0.4",
    "-f", "null",
    "-",
  ], { signal });
  if (result.code !== 0) {
    const message = result.stderr.trim().split("\n").slice(-6).join("\n");
    throw new Error(`ffmpeg silencedetect 失败（退出码 ${result.code}）：${message || "无错误输出"}`);
  }
  return parseSilence(result.stderr);
}

/** 解析 ebur128 的 Integrated loudness 与 Loudness Range。 */
export function parseLoudness(stderr: string) {
  const integrated = stderr.match(/I:\s*([-\d.]+)\s*LUFS/i);
  const range = stderr.match(/LRA:\s*([-\d.]+)\s*LU/i);
  if (!integrated || !range) return undefined;
  const i = Number(integrated[1]);
  const lra = Number(range[1]);
  if (!Number.isFinite(i) || !Number.isFinite(lra)) return undefined;
  return { integrated: Number(i.toFixed(2)), range: Number(lra.toFixed(2)) };
}

export async function measureLoudness(path: string, signal?: AbortSignal) {
  const settings = await loadSettings();
  const result = await runProcess([
    settings.ffmpeg.ffmpegPath,
    "-hide_banner",
    "-nostdin",
    "-i", path,
    "-af", "ebur128=framelog=verbose",
    "-f", "null",
    "-",
  ], { signal });
  if (result.code !== 0) {
    const message = result.stderr.trim().split("\n").slice(-6).join("\n");
    throw new Error(`ffmpeg ebur128 失败（退出码 ${result.code}）：${message || "无错误输出"}`);
  }
  const loudness = parseLoudness(result.stderr);
  if (!loudness) throw new Error("无法解析 ebur128 响度输出");
  return loudness;
}
