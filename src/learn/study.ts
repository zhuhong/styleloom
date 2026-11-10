import { stat } from "node:fs/promises";
import type { Project, SliceManifest, StyleBible } from "../types";
import type { Settings } from "../config";
import { nowIso } from "../util/fs";
import { saveProject } from "../store/projects";
import { saveStylePack } from "../store/library";
import { sliceVideo } from "./slice";
import { annotateShots } from "./annotate";
import { distillStyleBible } from "./distill";
import { extractSkillsFromStudy, type SkillExtractionResult } from "./skills";

export type StudyOptions = {
  project: Project;
  settings: Settings;
  sourcePath: string;
  focus?: string;
  maxShots?: number;
  force?: boolean;
  signal: AbortSignal;
  onProgress: (percent: number, label: string) => void;
};

export type StudyResult = {
  manifest: SliceManifest;
  bible: StyleBible;
  skills: SkillExtractionResult;
  warning?: string;
  skillWarning?: string;
};

/** 完整学习链路：本地切片 → VLM 逐镜标注 → 风格圣经 → 可复用风格包。 */
export async function studyReferenceVideo(options: StudyOptions): Promise<StudyResult> {
  const { project, settings, sourcePath, signal, onProgress } = options;
  const file = await stat(sourcePath).catch(() => undefined);
  if (!file?.isFile()) throw new Error(`参考视频不存在：${sourcePath}`);

  project.learning = {
    status: "slicing",
    source: sourcePath,
    focus: options.focus,
    updatedAt: nowIso(),
  };
  await saveProject(project);

  try {
    const manifest = await sliceVideo({
      project,
      sourcePath,
      settings,
      maxShots: options.maxShots,
      signal,
      onProgress: (percent, label) => onProgress(Math.round(percent * 0.42), label),
    });
    project.learning = {
      status: "annotating",
      source: sourcePath,
      focus: options.focus,
      shotCount: manifest.shots.length,
      sourceDuration: manifest.duration,
      sourceWidth: manifest.width,
      sourceHeight: manifest.height,
      updatedAt: nowIso(),
    };
    await saveProject(project);

    await annotateShots({
      project,
      manifest,
      settings,
      force: options.force,
      focus: options.focus,
      signal,
      onProgress: (percent, label) => onProgress(42 + Math.round(percent * 0.40), label),
    });
    project.learning.status = "distilling";
    project.learning.updatedAt = nowIso();
    await saveProject(project);

    const { bible, warning } = await distillStyleBible({
      project,
      manifest,
      settings,
      focus: options.focus,
      signal,
      onProgress: (percent, label) => onProgress(82 + Math.round(percent * 0.11), label),
    });
    project.styleBible = bible;
    project.learning.status = "distilling";
    project.learning.updatedAt = nowIso();
    await saveStylePack(
      project,
      manifest.shots.map(shot => ({ id: shot.id, duration: shot.duration, keyframe: shot.keyframe, clip: shot.clip })),
    );

    let skills: SkillExtractionResult = { created: [], merged: [], total: 0 };
    let skillWarning: string | undefined;
    try {
      skills = await extractSkillsFromStudy({
        project,
        manifest,
        bible,
        signal,
        onProgress: (percent, label) => onProgress(93 + Math.round(percent * 0.07), label),
      });
      skillWarning = skills.warning;
    } catch (error) {
      if (signal.aborted) throw error;
      skillWarning = `技能抽取失败，风格圣经已保留：${error instanceof Error ? error.message : String(error)}`;
    }
    project.learning.skills = { created: skills.created.length, merged: skills.merged.length };
    project.learning.status = "done";
    project.learning.error = undefined;
    project.learning.warning = [warning, skillWarning].filter(Boolean).join("；") || undefined;
    project.learning.updatedAt = nowIso();
    if (project.stage === "brief" || project.stage === "study") project.stage = "study";
    await saveProject(project);
    onProgress(100, "学习完成");
    return { manifest, bible, skills, warning, skillWarning };
  } catch (error) {
    project.learning.status = "failed";
    project.learning.error = error instanceof Error ? error.message : String(error);
    project.learning.updatedAt = nowIso();
    await saveProject(project);
    throw error;
  }
}
