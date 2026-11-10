import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Project } from "../types";
import type { Settings } from "../config";
import { addAsset, projectDir, saveProject } from "../store/projects";
import { ensureDir, safeJoin, stamp } from "../util/fs";
import { generateVideoJob } from "../providers/video/icompify";
import { composeShotPrompt, prepareReferences, validatePrompt } from "./prompt";
import { markSkillUsed } from "../store/skills";

export type GenerateShotOptions = {
  project: Project;
  settings: Settings;
  shotId: string;
  promptOverride?: string;
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
  skillIds: string[];
};

function shotById(project: Project, shotId: string) {
  const shot = project.plan.find(item => item.id === shotId);
  if (!shot) throw new Error(`分镜不存在：${shotId}`);
  return shot;
}

/** 单镜头生成：准备参考素材 → 编写 H3 提示词 → 提交 icompify → 落盘。 */
export async function generateShot(options: GenerateShotOptions): Promise<GenerateShotResult> {
  const { project, shotId, signal, onProgress } = options;
  const root = projectDir(project.id);
  const shot = shotById(project, shotId);
  if (!Number.isInteger(shot.durationSeconds) || shot.durationSeconds < 4 || shot.durationSeconds > 15) {
    throw new Error(`镜头 ${shotId} 时长 ${shot.durationSeconds} 秒不合法，H3 只接受 4-15 秒整数`);
  }
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
        duration: shot.durationSeconds,
        aspectRatio: project.brief.aspectRatio ?? options.settings.video.aspectRatio,
        references,
        signal,
      });
      prompt = composed.prompt;
      promptSource = composed.source;
      promptProblems = composed.problems;
    } else {
      promptProblems = validatePrompt(prompt, references.mode, shot.durationSeconds);
    }
    shot.prompt = prompt;
    shot.promptMode = references.mode;
    shot.status = "promptReady";
    await saveProject(project);

    onProgress(18, `提交 ${references.mode.toUpperCase()} 任务`);
    const result = await generateVideoJob({
      prompt,
      durationSeconds: shot.durationSeconds,
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

    onProgress(94, "保存视频");
    await ensureDir(join(root, "assets", "videos"));
    const relative = `assets/videos/${shotId}-${stamp()}.mp4`;
    await writeFile(join(root, relative), result.bytes);
    shot.video = relative;
    shot.videoId = result.videoId;
    shot.status = "done";
    shot.updatedAt = new Date().toISOString();
    addAsset(project, {
      kind: "video",
      path: relative,
      label: `${shotId} ${shot.title}`,
      meta: { shotId, model: result.model, task: result.task, videoId: result.videoId, promptSource },
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
      skillIds: shot.skillIds ?? [],
    };
  } catch (error) {
    shot.status = "failed";
    shot.error = error instanceof Error ? error.message : String(error);
    shot.updatedAt = new Date().toISOString();
    await saveProject(project);
    throw error;
  }
}

