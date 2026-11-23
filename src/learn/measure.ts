import type { MeasureManifest, Project, ShotMeasurement, SliceManifest } from "../types";
import {
  detectSilence,
  measureLoudness,
  sampleGrid,
  sampleGridFromImage,
} from "../util/ffmpeg";
import { exists, nowIso, safeJoin } from "../util/fs";
import { projectDir, saveMeasure } from "../store/projects";

export type MeasureOptions = {
  project: Project;
  manifest: SliceManifest;
  /** slice 一次检测留下的切点；禁止在此再跑 detectCuts */
  cuts: { time: number; score: number }[];
  sourcePath: string;
  signal: AbortSignal;
  onProgress: (percent: number, label: string) => void;
};

const GRID_COLS = 8;
const GRID_ROWS = 6;
const PALETTE_TOP = 6;

/** ACT: 4-bit 量化桶计频，非感知聚类；48 像素够作提示词色板锚点。 */
function quantizeHex(r: number, g: number, b: number) {
  const qr = (r >> 4) << 4;
  const qg = (g >> 4) << 4;
  const qb = (b >> 4) << 4;
  return `#${qr.toString(16).padStart(2, "0")}${qg.toString(16).padStart(2, "0")}${qb.toString(16).padStart(2, "0")}`;
}

function lumaOf(r: number, g: number, b: number) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function summarizeGrid(rgb: Uint8Array) {
  const counts = new Map<string, number>();
  const lumas: number[] = [];
  for (let offset = 0; offset + 2 < rgb.length; offset += 3) {
    const r = rgb[offset];
    const g = rgb[offset + 1];
    const b = rgb[offset + 2];
    const hex = quantizeHex(r, g, b);
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
    lumas.push(lumaOf(r, g, b));
  }
  const palette = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, PALETTE_TOP)
    .map(([hex]) => hex);
  const mean = lumas.length ? lumas.reduce((sum, value) => sum + value, 0) / lumas.length : 0;
  const variance = lumas.length
    ? lumas.reduce((sum, value) => sum + (value - mean) ** 2, 0) / lumas.length
    : 0;
  return {
    palette,
    luma: Number(mean.toFixed(1)),
    contrast: Number(Math.sqrt(variance).toFixed(1)),
  };
}

function durationStats(durations: number[]) {
  if (!durations.length) return { min: 0, median: 0, max: 0, mean: 0 };
  const sorted = [...durations].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    min: Number(sorted[0].toFixed(3)),
    median: Number(median.toFixed(3)),
    max: Number(sorted[sorted.length - 1].toFixed(3)),
    mean: Number(mean.toFixed(3)),
  };
}

function mergePalettes(shots: ShotMeasurement[]) {
  const counts = new Map<string, number>();
  for (const shot of shots) {
    shot.palette.forEach((hex, index) => {
      counts.set(hex, (counts.get(hex) ?? 0) + (PALETTE_TOP - index));
    });
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, PALETTE_TOP)
    .map(([hex]) => hex);
}

async function measureShotGrid(
  root: string,
  shot: SliceManifest["shots"][number],
  sourcePath: string,
  signal: AbortSignal,
) {
  const keyframeAbs = safeJoin(root, shot.keyframe);
  if (await exists(keyframeAbs)) {
    const grid = await sampleGridFromImage(keyframeAbs, GRID_COLS, GRID_ROWS, signal);
    return summarizeGrid(grid.rgb);
  }
  const mid = shot.start + Math.min(shot.duration / 2, Math.max(0, shot.duration - 0.05));
  const grid = await sampleGrid(sourcePath, mid, GRID_COLS, GRID_ROWS, signal);
  return summarizeGrid(grid.rgb);
}

/** 在切片与标注之间跑客观测量；失败由 study 吞掉写 warning。 */
export async function measureReference(options: MeasureOptions): Promise<MeasureManifest> {
  const { project, manifest, cuts, sourcePath, signal, onProgress } = options;
  const root = projectDir(project.id);
  const shots: ShotMeasurement[] = [];
  const total = Math.max(1, manifest.shots.length);

  for (let index = 0; index < manifest.shots.length; index++) {
    signal.throwIfAborted();
    const shot = manifest.shots[index];
    onProgress(Math.round(((index + 1) / total) * 70), `测量镜头 ${shot.id}`);
    const summary = await measureShotGrid(root, shot, sourcePath, signal);
    shots.push({ shotId: shot.id, ...summary });
  }

  let silence: { start: number; end: number }[] = [];
  let loudness: MeasureManifest["overall"]["loudness"];
  if (manifest.hasAudio) {
    onProgress(78, "测量静音段");
    const audioAbs = manifest.audio ? safeJoin(root, manifest.audio) : sourcePath;
    silence = await detectSilence(audioAbs, signal);
    onProgress(88, "测量响度");
    loudness = await measureLoudness(audioAbs, signal);
  } else {
    onProgress(85, "无音轨，跳过静音/响度");
  }

  const overallLuma = shots.length
    ? Number((shots.reduce((sum, shot) => sum + shot.luma, 0) / shots.length).toFixed(1))
    : 0;
  const overallContrast = shots.length
    ? Number((shots.reduce((sum, shot) => sum + shot.contrast, 0) / shots.length).toFixed(1))
    : 0;

  const measure: MeasureManifest = {
    version: 1,
    createdAt: nowIso(),
    grid: { cols: GRID_COLS, rows: GRID_ROWS },
    overall: {
      palette: mergePalettes(shots),
      luma: overallLuma,
      contrast: overallContrast,
      cuts: cuts.map(cut => ({
        time: Number(cut.time.toFixed(3)),
        score: Number(cut.score.toFixed(4)),
      })),
      cutsSource: manifest.method,
      durationStats: durationStats(manifest.shots.map(shot => shot.duration)),
      silence,
      ...(loudness ? { loudness } : {}),
    },
    shots,
  };

  await saveMeasure(project, measure);
  onProgress(100, "测量完成");
  return measure;
}

/** 把 overall 色板/亮度压成可注入 H3 style 段的短句。 */
export function measureStyleAnchor(measure: MeasureManifest | undefined) {
  if (!measure) return "";
  const { palette, luma, contrast } = measure.overall;
  if (!palette.length) return "";
  const contrastLabel = contrast < 28 ? "low contrast" : contrast > 55 ? "high contrast" : "moderate contrast";
  return `overall palette ${palette.join(" / ")}, mean luma ${luma}/255, ${contrastLabel}`;
}
