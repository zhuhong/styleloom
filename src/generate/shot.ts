import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Project } from "../types";
import { dataDir, type Settings } from "../config";
import { addAsset, projectDir, saveProject } from "../store/projects";
import { ensureDir, removeDir, safeJoin, stamp } from "../util/fs";
import { runFfmpeg } from "../util/ffmpeg";
import { H3_SAFE_MIN_SECONDS, normalizeShotDuration, providerDurationFor } from "../util/duration";
import { generateVideoJob } from "../providers/video/icompify";
import { composeShotPrompt, prepareReferences, validatePrompt } from "./prompt";
import { markSkillUsed } from "../store/skills";

export type GenerateShotOptions = {
  project: Project;
  settings: Settings;
  shotId: string;
  promptOverride?: string;
  /** 可选：覆盖分镜时长，1-15 秒整数 */
  durationSeconds?: number;
  /** 低于 4 秒时是否直接请求 H3；默认 false，按 4 秒生成后裁剪 */
  experimentalDuration?: boolean;
  skillIds?: string[];
  signal: AbortSignal;
  onProgress: (percent: number, label: string) => void;
};

export type GenerateShotResult = {
  shotId: string;
  video: string;
  videoId: string;
  prompt: string;
  mode: string;
  promptSource: "llm" | "template" | "manual";
  promptProblems: string[];
  requestedDurationSeconds: number;
  providerDurationSeconds: number;
  trimmed: boolean;
  durationNote?: string;
  skillIds: string[];
};

function shotById(project: Project, shotId: string) {
  const shot = project.plan.find(item => item.id === shotId);
  if (!shot) throw new Error(`分镜不存在：${shotId}`);
  return shot;
}

/** 短镜头回退：先按 H3 常规下限生成，再本地裁到目标时长。 */
export async function trimVideo(input: string, output: string, seconds: number, signal: AbortSignal) {
  await runFfmpeg([
    "-y",
    "-i", input,
    "-t", String(seconds),
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

/** 单镜头生成：准备参考素材 → 编写 H3 提示词 → 提交 icompify → 落盘。 */
export async function generateShot(options: GenerateShotOptions): Promise<GenerateShotResult> {
  const { project, shotId, signal, onProgress } = options;
  const root = projectDir(project.id);
  const shot = shotById(project, shotId);
  const requestedDuration = normalizeShotDuration(options.durationSeconds ?? shot.durationSeconds, `镜头 ${shotId} `);
  if (options.durationSeconds !== undefined) shot.durationSeconds = requestedDuration;
  const providerDuration = providerDurationFor(requestedDuration, options.experimentalDuration === true);
  const willTrim = providerDuration !== requestedDuration;
  const durationNote = willTrim
    ? `H3 常规下限 ${H3_SAFE_MIN_SECONDS}s：本次按 ${providerDuration}s 生成后裁剪到 ${requestedDuration}s`
    : options.experimentalDuration === true && requestedDuration < H3_SAFE_MIN_SECONDS
      ? `实验档位：直接请求 H3 ${requestedDuration}s；若平台拒绝会返回错误`
      : undefined;
  const stampValue = stamp();
  let tempDir: string | undefined;
  shot.status = "generating";
  shot.error = undefined;
  if (options.skillIds) shot.skillIds = [...new Set(options.skillIds)];
  await saveProject(project);

  try {
    onProgress(5, "准备参考素材与生成模式");
    const references = await prepareReferences(project, shot);
    const absolute = (path: string) => safeJoin(root, path);

    let prompt = options.promptOverride?.trim();
    let promptSource: "llm" | "template" | "manual" = "manual";
    let promptProblems: string[] = [];
    if (!prompt) {
      onProgress(10, "编写 H3 提示词");
      const composed = await composeShotPrompt({
        shot,
        bible: project.styleBible,
        mode: references.mode,
        duration: requestedDuration,
        aspectRatio: project.brief.aspectRatio ?? options.settings.video.aspectRatio,
        references,
        signal,
      });
      prompt = composed.prompt;
      promptSource = composed.source;
      promptProblems = composed.problems;
    } else {
      promptProblems = validatePrompt(prompt, references.mode, requestedDuration);
    }
    shot.prompt = prompt;
    shot.promptMode = references.mode;
    shot.status = "promptReady";
    await saveProject(project);

    onProgress(18, `提交 ${references.mode.toUpperCase()} 任务`);
    const result = await generateVideoJob({
      prompt,
      durationSeconds: providerDuration,
      aspectRatio: project.brief.aspectRatio ?? options.settings.video.aspectRatio,
      firstFrame: references.firstFrame ? absolute(references.firstFrame) : undefined,
      lastFrame: references.lastFrame ? absolute(references.lastFrame) : undefined,
      referenceImages: references.mode === "ref2va" ? references.images.map(image => absolute(image.path)) : [],
      referenceVideos: references.mode === "ref2va" ? references.videos.map(video => absolute(video.path)) : [],
      signal,
      onVideoId: videoId => {
        shot.videoId = videoId;
        void saveProject(project).catch(() => {});
      },
      onProgress: (status, elapsed, percent) => {
        const value = typeof percent === "number" ? 20 + Math.min(70, percent * 0.7) : 40;
        onProgress(Math.round(value), `H3 ${status} · ${elapsed}s`);
      },
    });

    onProgress(92, "保存视频");
    await ensureDir(join(root, "assets", "videos"));
    const relative = `assets/videos/${shotId}-${stampValue}.mp4`;
    if (willTrim) {
      tempDir = join(dataDir, "cache", "short-shots", `${project.id}-${shotId}-${stampValue}`);
      await ensureDir(tempDir);
      const rawPath = join(tempDir, "raw.mp4");
      await writeFile(rawPath, result.bytes);
      onProgress(95, `H3 已生成 ${providerDuration}s，裁剪到 ${requestedDuration}s`);
      await trimVideo(rawPath, join(root, relative), requestedDuration, signal);
    } else {
      await writeFile(join(root, relative), result.bytes);
    }
    shot.video = relative;
    shot.videoId = result.videoId;
    shot.status = "done";
    shot.updatedAt = new Date().toISOString();
    addAsset(project, {
      kind: "video",
      path: relative,
      label: `${shotId} ${shot.title}`,
      meta: {
        shotId,
        model: result.model,
        task: result.task,
        videoId: result.videoId,
        promptSource,
        requestedDurationSeconds: requestedDuration,
        providerDurationSeconds: providerDuration,
        trimmed: willTrim,
        durationExperimental: Boolean(options.experimentalDuration && requestedDuration < H3_SAFE_MIN_SECONDS),
      },
    });
    if (project.stage === "plan" || project.stage === "study") project.stage = "generate";
    await saveProject(project);
    for (const skillId of shot.skillIds ?? []) {
      await markSkillUsed(skillId, { projectId: project.id, shotId }).catch(() => undefined);
    }
    onProgress(100, `${shotId} 生成完成`);
    return {
      shotId,
      video: relative,
      videoId: result.videoId,
      prompt,
      mode: references.mode,
      promptSource,
      promptProblems,
      requestedDurationSeconds: requestedDuration,
      providerDurationSeconds: providerDuration,
      trimmed: willTrim,
      durationNote,
      skillIds: shot.skillIds ?? [],
    };
  } catch (error) {
    shot.status = "failed";
    shot.error = error instanceof Error ? error.message : String(error);
    shot.updatedAt = new Date().toISOString();
    await saveProject(project);
    throw error;
  } finally {
    if (tempDir) await removeDir(tempDir).catch(() => undefined);
  }
}

