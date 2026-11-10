import { basename, join } from "node:path";
import type { Project } from "../types";
import { dataDir } from "../config";
import { addAsset, projectDir, saveProject } from "../store/projects";
import { ensureDir, exists, removeDir, safeJoin, slugify, stamp, writeText } from "../util/fs";
import { probeMedia, runFfmpeg } from "../util/ffmpeg";

export type StitchOptions = {
  project: Project;
  /** 要拼接的镜头 id，按数组顺序；不传则取所有已生成镜头 */
  shotIds?: string[];
  /** 输出文件名，默认 final-项目名-总时长s.mp4 */
  outputName?: string;
  /** 镜头间叠化秒数；0 或不传为硬切 */
  transitionSeconds?: number;
  /** 同名文件是否覆盖，默认 true */
  overwrite?: boolean;
  signal?: AbortSignal;
  onProgress?: (percent: number, label: string) => void;
};

export type StitchResult = {
  ok: true;
  relative: string;
  absolute: string;
  shotIds: string[];
  clips: number;
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
  transitionSeconds: number;
  note: string;
};

function quoteConcatPath(path: string) {
  return path.replaceAll("'", "'\\''");
}

function cleanOutputName(project: Project, totalSeconds: number, outputName?: string) {
  const raw = outputName?.trim() || `final-${slugify(project.title, "video")}-${Math.round(totalSeconds)}s.mp4`;
  const base = basename(raw).replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-");
  return base.toLowerCase().endsWith(".mp4") ? base : `${base}.mp4`;
}

/** 把已生成的分镜按顺序拼成一条成片：统一转码 → 硬切或叠化 → 输出 H.264/AAC。 */
export async function stitchShots(options: StitchOptions): Promise<StitchResult> {
  const { project, signal, onProgress } = options;
  const root = projectDir(project.id);
  const progress = (percent: number, label: string) => onProgress?.(percent, label);
  const requested = options.shotIds?.length ? options.shotIds : project.plan.filter(shot => shot.video).map(shot => shot.id);
  if (!requested.length) throw new Error("没有可拼接的镜头：先生成至少一个分镜视频");

  const shots = requested.map(id => {
    const shot = project.plan.find(item => item.id === id);
    if (!shot) throw new Error(`分镜不存在：${id}`);
    if (!shot.video) throw new Error(`分镜 ${id} 还没有视频，先生成再拼接`);
    return shot;
  });
  const absolute = shots.map(shot => safeJoin(root, shot.video!));
  for (const [index, path] of absolute.entries()) {
    if (!(await exists(path))) throw new Error(`分镜视频文件不存在：${shots[index].video}`);
  }

  progress(3, "读取分镜参数");
  const infos = [];
  for (const [index, path] of absolute.entries()) {
    signal?.throwIfAborted();
    const info = await probeMedia(path, signal);
    if (!info.width || !info.height || !info.duration) throw new Error(`无法读取分镜 ${shots[index].id} 的视频参数`);
    infos.push(info);
  }

  const width = infos[0].width + (infos[0].width % 2);
  const height = infos[0].height + (infos[0].height % 2);
  const fps = Math.min(60, Math.max(12, Number(infos[0].fps.toFixed(3))));
  const durations = infos.map(info => info.duration);
  const transitionSeconds = Math.max(0, Number(options.transitionSeconds ?? 0));
  if (transitionSeconds > 0 && transitionSeconds >= Math.min(...durations) - 0.05) {
    throw new Error(`叠化时长 ${transitionSeconds}s 太长，必须小于最短镜头时长 ${Math.min(...durations).toFixed(2)}s`);
  }

  const tempDir = join(dataDir, "cache", "stitch", `${project.id}-${stamp()}`);
  await ensureDir(tempDir);
  const normalized: string[] = [];
  try {
    for (const [index, input] of absolute.entries()) {
      signal?.throwIfAborted();
      const info = infos[index];
      const output = join(tempDir, `normalized-${String(index + 1).padStart(2, "0")}.mp4`);
      const args = ["-y", "-i", input];
      if (!info.hasAudio) {
        args.push("-f", "lavfi", "-t", info.duration.toFixed(3), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
      }
      const filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps}`;
      args.push(
        "-vf", filter,
        "-af", "apad",
        "-t", info.duration.toFixed(3),
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-ar", "48000",
        "-ac", "2",
        "-movflags", "+faststart",
      );
      if (!info.hasAudio) args.push("-map", "0:v:0", "-map", "1:a:0");
      args.push(output);
      progress(12 + Math.round(((index + 1) / absolute.length) * 50), `统一转码 ${index + 1}/${absolute.length}`);
      await runFfmpeg(args, { signal });
      normalized.push(output);
    }

    const nominalDuration = shots.reduce((total, shot) => total + shot.durationSeconds, 0);
    const outputName = cleanOutputName(project, nominalDuration, options.outputName);
    let relative = `assets/videos/${outputName}`;
    if (options.overwrite === false && (await exists(safeJoin(root, relative)))) {
      relative = `assets/videos/${outputName.replace(/\.mp4$/i, "")}-${stamp()}.mp4`;
    }
    const output = safeJoin(root, relative);
    await ensureDir(join(root, "assets", "videos"));

    if (transitionSeconds > 0 && normalized.length > 1) {
      progress(68, "叠化拼接");
      const args: string[] = ["-y"];
      for (const path of normalized) args.push("-i", path);
      const filters: string[] = [];
      let videoLabel = "0:v";
      let audioLabel = "0:a";
      let elapsed = durations[0];
      for (let index = 1; index < normalized.length; index += 1) {
        const videoOut = `v${index}`;
        const audioOut = `a${index}`;
        const offset = elapsed - transitionSeconds;
        filters.push(`[${videoLabel}][${index}:v]xfade=transition=fade:duration=${transitionSeconds}:offset=${offset.toFixed(3)}[${videoOut}]`);
        filters.push(`[${audioLabel}][${index}:a]acrossfade=d=${transitionSeconds}:c1=tri:c2=tri[${audioOut}]`);
        videoLabel = videoOut;
        audioLabel = audioOut;
        elapsed = elapsed + durations[index] - transitionSeconds;
      }
      args.push(
        "-filter_complex", filters.join(";"),
        "-map", `[${videoLabel}]`,
        "-map", `[${audioLabel}]`,
        "-c:v", "libx264",
        "-preset", "slow",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        output,
      );
      await runFfmpeg(args, { signal });
    } else {
      progress(68, "拼接成片");
      const concatFile = join(tempDir, "concat.txt");
      await writeText(concatFile, normalized.map(path => `file '${quoteConcatPath(path)}'`).join("\n"));
      await runFfmpeg([
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concatFile,
        "-c:v", "libx264",
        "-preset", "slow",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        output,
      ], { signal });
    }

    progress(96, "校验成片");
    const info = await probeMedia(output, signal);
    const duration = Number(info.duration.toFixed(3));
    project.assets = project.assets.filter(asset => asset.path !== relative);
    addAsset(project, {
      kind: "video",
      path: relative,
      label: `成片 · ${shots.length} 镜 · ${duration.toFixed(1)}s`,
      meta: {
        kind: "final",
        shotIds: shots.map(shot => shot.id),
        durationSeconds: duration,
        width: info.width,
        height: info.height,
        transitionSeconds,
        source: "stitch",
      },
    });
    project.stage = "deliver";
    await saveProject(project);
    progress(100, "成片已生成");
    return {
      ok: true,
      relative,
      absolute: output,
      shotIds: shots.map(shot => shot.id),
      clips: shots.length,
      durationSeconds: duration,
      width: info.width,
      height: info.height,
      hasAudio: info.hasAudio,
      transitionSeconds,
      note: transitionSeconds > 0 ? `已按 ${transitionSeconds}s 叠化拼接` : "已硬切拼接",
    };
  } finally {
    await removeDir(tempDir).catch(() => undefined);
  }
}
