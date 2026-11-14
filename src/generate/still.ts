import { copyFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Project } from "../types";
import type { Settings } from "../config";
import { addAsset, projectDir, saveProject } from "../store/projects";
import { normalizeStyleBible } from "../learn/bible";
import { ensureDir, exists, safeJoin, stamp } from "../util/fs";
import { generateImageWithModel } from "../providers/image";

export type StillTarget = "character" | "location";

export type StillResult = {
  target: StillTarget;
  id: string;
  path: string;
  source: "model" | "reference";
  backend?: "openrouter" | "openai" | "local";
  model?: string;
  references?: number;
  note?: string;
};

/**
 * 生成定妆照 / 场景照。
 * 未配置图片模型时，回退为从参考片学习到的关键帧，并明确标注是参考图而不是新生成的定妆照。
 */
export async function generateStill(options: {
  project: Project;
  settings: Settings;
  target: StillTarget;
  id: string;
  promptOverride?: string;
  signal?: AbortSignal;
  onProgress?: (percent: number, label: string) => void;
}): Promise<StillResult> {
  const { project, settings, target, id } = options;
  if (project.styleBible) project.styleBible = normalizeStyleBible(project.styleBible);
  const bible = project.styleBible;
  if (!bible) throw new Error("还没有风格圣经，请先学习参考视频或套用风格包");
  const sheet = target === "character" ? bible.characters.find(item => item.id === id) : bible.locations.find(item => item.id === id);
  if (!sheet) throw new Error(`${target === "character" ? "角色" : "场景"}不存在：${id}`);
  const prompt = (options.promptOverride?.trim() || sheet.stillPrompt || "").trim();
  if (!prompt) throw new Error("定妆照提示词为空");
  const root = projectDir(project.id);
  await ensureDir(join(root, "assets", "stills"));

  // 本地 5090 Qwen 支持多张条件图；优先用学习阶段抽出的真实参考帧，
  // 没有参考帧时才用已经生成过的定妆照/场景照。
  const references: string[] = [];
  for (const relative of [...(sheet.refImages ?? []), ...(sheet.stillImages ?? [])]) {
    if (references.length >= 3) break;
    if (references.includes(relative)) continue;
    try {
      const absolute = safeJoin(root, relative);
      if (await exists(absolute)) references.push(absolute);
    } catch {
      // 旧项目里的坏路径直接跳过
    }
  }

  const image = await generateImageWithModel({
    prompt,
    size: settings.image.size,
    ratio: project.brief.aspectRatio ?? "16:9",
    references,
    signal: options.signal,
    onProgress: options.onProgress,
  });

  if (image) {
    const extension = image.mimeType.includes("png") ? ".png" : image.mimeType.includes("webp") ? ".webp" : ".jpg";
    const relative = `assets/stills/${target}-${id}-${stamp()}${extension}`;
    const usedReferences = image.backend === "local" ? references.length : 0;
    await writeFile(join(root, relative), image.bytes);
    sheet.stillImages = [...new Set([relative, ...(sheet.stillImages ?? [])])].slice(0, 4);
    addAsset(project, { kind: "still", path: relative, label: `${target === "character" ? "定妆照" : "场景照"} ${sheet.name}`, meta: { target, id, model: image.model, backend: image.backend, references: usedReferences, prompt } });
    await saveProject(project);
    return {
      target,
      id,
      path: relative,
      source: "model",
      backend: image.backend,
      model: image.model,
      references: usedReferences,
      note: image.backend === "local" ? `5090 Qwen 本地生成${image.seconds ? `，${image.seconds.toFixed(1)}s` : ""}` : undefined,
    };
  }

  const fallback = (sheet as { refImages?: string[] }).refImages?.[0];
  if (!fallback) throw new Error("未配置图片模型，且该条目没有可用的参考关键帧；请在设置里配置图片模型");
  const source = safeJoin(root, fallback);
  if (!(await exists(source))) throw new Error(`参考关键帧不存在：${fallback}`);
  const extension = extname(fallback) || ".jpg";
  const relative = `assets/stills/${target}-${id}-reference${extension}`;
  await copyFile(source, join(root, relative));
  sheet.stillImages = [...new Set([relative, ...(sheet.stillImages ?? [])])].slice(0, 4);
  addAsset(project, { kind: "still", path: relative, label: `${target === "character" ? "参考定妆" : "参考场景"} ${sheet.name}`, meta: { target, id, source: "reference", from: fallback } });
  await saveProject(project);
  options.onProgress?.(100, "使用参考帧");
  return {
    target,
    id,
    path: relative,
    source: "reference",
    note: "未配置图片模型，已使用参考片关键帧作为参考图。要生成新的定妆照，请在设置里填写图片模型。",
  };
}
