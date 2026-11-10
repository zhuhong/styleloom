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
