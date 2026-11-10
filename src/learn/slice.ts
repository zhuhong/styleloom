import { join } from "node:path";
import type { Project, SliceManifest, SliceShot } from "../types";
import type { Settings } from "../config";
import { ensureDir, nowIso, removeDir, toProjectPath } from "../util/fs";
import { detectCuts, extractAudio, extractClip, extractFrame, probeMedia } from "../util/ffmpeg";
import { projectDir, saveManifest } from "../store/projects";

export type ProgressFn = (percent: number, label: string) => void;

export type SliceOptions = {
  project: Project;
  sourcePath: string;
  settings: Settings;
  maxShots?: number;
  sampleCount?: number;
  signal: AbortSignal;
  onProgress: ProgressFn;
};

const SAMPLE_FRACTIONS = [0.15, 0.5, 0.85];

function buildBoundaries(duration: number, cuts: { time: number; score: number }[], minShotSeconds: number, maxShots: number) {
  const lastStart = duration - minShotSeconds;
  const filtered: number[] = [];
  for (const cut of cuts.sort((left, right) => left.time - right.time)) {
    const previous = filtered.length ? filtered[filtered.length - 1] : 0;
    if (cut.time - previous < minShotSeconds || cut.time > lastStart) continue;
    filtered.push(cut.time);
  }
  const sceneBoundaries = [0, ...filtered, duration];
  if (sceneBoundaries.length - 1 <= maxShots) return { boundaries: sceneBoundaries, method: "scene" as const };
  // ACT: 超过 maxShots 时退回等分切片，长片会丢失真实切点；后续可按分段+合并升级。
  const count = Math.max(1, maxShots);
  const interval = duration / count;
  return {
    boundaries: Array.from({ length: count + 1 }, (_, index) => Math.min(duration, index * interval)),
    method: "interval" as const,
  };
}

function sampleTimes(start: number, duration: number, count: number) {
  const times: number[] = [];
  for (let index = 0; index < Math.min(count, SAMPLE_FRACTIONS.length); index++) {
    const time = start + duration * SAMPLE_FRACTIONS[index];
    if (!times.some(existing => Math.abs(existing - time) < 0.05)) times.push(time);
  }
  return times;
}

/** 本地拉片：检测切点，抽取关键帧/时序采样/镜头片段/原音轨。 */
export async function sliceVideo(options: SliceOptions): Promise<SliceManifest> {
  const { project, sourcePath, settings, signal, onProgress } = options;
  const root = projectDir(project.id);
  const learningDir = join(root, "learning");
  const shotsDir = join(learningDir, "shots");
  const maxShots = options.maxShots ?? settings.learning.maxShots;
  const sampleCount = options.sampleCount ?? settings.learning.sampleCount;

  onProgress(2, "读取视频信息");
  const info = await probeMedia(sourcePath, signal);
  if (!info.duration || !info.width) throw new Error("无法读取视频时长或画面尺寸，文件可能损坏");
  signal.throwIfAborted();

  onProgress(6, "检测镜头切点");
  const cuts = await detectCuts(sourcePath, settings.learning.sceneThreshold, signal);
  const { boundaries, method } = buildBoundaries(info.duration, cuts, settings.learning.minShotSeconds, maxShots);
  signal.throwIfAborted();

  await removeDir(shotsDir);
  await ensureDir(shotsDir);

  const shots: SliceShot[] = [];
  const total = boundaries.length - 1;
  for (let index = 0; index < total; index++) {
    signal.throwIfAborted();
    const start = boundaries[index];
    const end = boundaries[index + 1];
    const duration = end - start;
    if (duration < 0.15) continue;
    const id = `s${String(index + 1).padStart(2, "0")}`;
    const directory = join(shotsDir, id);
    await ensureDir(directory);
    const percent = 10 + (index / total) * 80;
    onProgress(percent, `抽取镜头 ${id}（${index + 1}/${total}）`);

    const keyframePath = join(directory, "frame.jpg");
    const keyframeTime = start + Math.min(duration / 2, Math.max(0, duration - 0.05));
    await extractFrame(sourcePath, keyframeTime, keyframePath, 960, signal);

    const samples: string[] = [];
    const times = sampleTimes(start, duration, sampleCount);
    for (let sample = 0; sample < times.length; sample++) {
      const path = join(directory, `sample${sample + 1}.jpg`);
      await extractFrame(sourcePath, times[sample], path, 640, signal);
      samples.push(toProjectPath(root, path));
    }

    let clip: string | undefined;
    if (settings.learning.keepClips) {
      onProgress(percent + 0.5, `切出镜头 ${id}`);
      const clipPath = join(directory, "clip.mp4");
      await extractClip(sourcePath, start, duration, clipPath, signal);
      clip = toProjectPath(root, clipPath);
    }

    shots.push({
      id,
      index: index + 1,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      duration: Number(duration.toFixed(3)),
      keyframe: toProjectPath(root, keyframePath),
      samples,
      clip,
    });
  }

  let audio: string | undefined;
  if (info.hasAudio) {
    onProgress(92, "抽取原音轨");
    const audioPath = join(learningDir, "audio.m4a");
    await extractAudio(sourcePath, audioPath, signal);
    audio = toProjectPath(root, audioPath);
  }

  const manifest: SliceManifest = {
    source: sourcePath,
    sourceName: sourcePath.split("/").pop() ?? "reference",
    duration: Number(info.duration.toFixed(3)),
    width: info.width,
    height: info.height,
    fps: Number(info.fps.toFixed(3)),
    hasAudio: info.hasAudio,
    method,
    shots,
    audio,
    createdAt: nowIso(),
  };
  await saveManifest(project, manifest);
  onProgress(95, `已切出 ${shots.length} 个镜头`);
  return manifest;
}
