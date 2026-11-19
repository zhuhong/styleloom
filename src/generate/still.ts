import { copyFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Project, Skill } from "../types";
import type { Settings } from "../config";
import { addAsset, projectDir, saveProject } from "../store/projects";
import { normalizeStyleBible } from "../learn/bible";
import { ensureDir, exists, safeJoin, stamp } from "../util/fs";
import { generateImageWithModel, type ImageBackend } from "../providers/image";
import { loadSkillsByIds, markSkillUsed, searchSkills, skillPromptInjection } from "../store/skills";

export type StillTarget = "character" | "location";

export type StillResult = {
  target: StillTarget;
  id: string;
  path: string;
  source: "model" | "reference";
  backend?: ImageBackend;
  model?: string;
  references?: number;
  /** 本次注入到出图提示词里的技能（成功出图后才记 usage）。 */
  skillIds?: string[];
  note?: string;
};

/** 自动检索时只认「已经能打」的技能，避免早期 0 置信度的候选条目乱改提示词。 */
function skillUsable(skill: Skill) {
  // 没有 promptFragment 的技能（纯流程/避坑说明）拼不进提示词，自动选型时不带；需要时仍可显式指定。
  return Boolean(skill.promptFragment.trim()) && (skill.status === "active" || skill.confidence >= 0.3);
}

/**
 * 人物照与场景照互斥：场景照技能里的「空场景 / 无人物」拼进人物照会直接毁掉出图。
 * 用 tags（character / location）优先判断，没有再退回名称与摘要里的中文关键词。
 */
export function stillTargetMatch(skill: Pick<Skill, "name" | "summaryZh" | "tags">, target: StillTarget) {
  const tags = skill.tags.map(tag => tag.toLowerCase());
  const text = `${skill.name} ${skill.summaryZh}`;
  const locationish = tags.includes("location") || /场景照|空场景/.test(text);
  const characterish = tags.includes("character") || /定妆照|角色/.test(text);
  if (locationish && !characterish) return target === "location";
  if (characterish && !locationish) return target === "character";
  return true;
}

/**
 * 选出本次要用的出图技能。
 * 显式传入的 id 只做表面过滤（appliesTo 不含 still 的不进提示词，也不会报错），
 * 自动检索则额外过滤掉人物/场景不匹配的技能。
 */
export async function pickStillSkills(explicitIds: string[] | undefined, target: StillTarget, sheetName: string) {
  const ids = [...new Set((explicitIds ?? []).map(id => id.trim()).filter(Boolean))];
  if (ids.length) {
    const found = await loadSkillsByIds(ids);
    const usable = found.filter(skill => skillPromptInjection([skill], { surface: "still" }).notes.length > 0);
    if (!usable.length) throw new Error(`指定的技能都不适用于出图：${ids.join("、")}（需要 appliesTo 含 still）`);
    return usable;
  }
  const query = `${target === "character" ? "定妆照 角色 全身 参考帧" : "场景照 空场景 参考帧"} ${sheetName}`;
  const scored = await searchSkills(query, { surface: "still", limit: 8 });
  return scored
    .map(item => item.skill)
    .filter(skill => skillUsable(skill) && stillTargetMatch(skill, target))
    .slice(0, 3);
}

/**
 * 把技能片段拼在 stillPrompt 后面。
 * - 剥掉与 stillPrompt 重复的风格前缀：多条技能共用同一个 stylePrefix，不剥会把前缀叠三遍。
 * - 按整段去重（早期实现按前 60 字符比较，导致第二条技能永远被当成重复丢掉）。
 * - 技能里的 avoidWhen 是「什么情况下不该用这条技能」，不是负面提示词，所以不往图片提示词里塞 Avoid 句。
 */
export function composeStillPrompt(base: string, skills: Skill[], stylePrefix = "") {
  const { fragments } = skillPromptInjection(skills, { surface: "still" });
  const lower = base.toLowerCase();
  const prefix = stylePrefix.trim().toLowerCase();
  const extra: string[] = [];
  const seen = new Set<string>();
  for (const fragment of fragments) {
    let value = fragment.trim().replace(/\s+/g, " ");
    if (prefix && value.toLowerCase().startsWith(prefix)) value = value.slice(prefix.length).replace(/^[\s,;]+/, "");
    const key = value.toLowerCase();
    if (!value || seen.has(key) || lower.includes(key)) continue;
    seen.add(key);
    extra.push(value);
  }
  return [base, ...extra].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

/** 只在真的出图成功后才记 usage：调用失败不该污染技能统计。 */
async function markStillSkillsUsed(skills: Skill[], projectId: string, target: StillTarget, id: string) {
  const applied: string[] = [];
  for (const skill of skills) {
    // 公开技能只读，不写回、不记反馈（与 search_skills/read_skill 的口径一致）。
    if (skill.source === "public") {
      applied.push(skill.id);
      continue;
    }
    try {
      await markSkillUsed(skill.id, { projectId, shotId: `still:${target}:${id}` });
      applied.push(skill.id);
    } catch {
      // 技能文件被删/损坏不影响出图
    }
  }
  return applied;
}

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
  /** 显式指定技能；留空则按「定妆照/场景照」自动检索出图技能（appliesTo 含 still）。 */
  skillIds?: string[];
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

  // 本地出图后端支持多张条件图；优先用学习阶段抽出的真实参考帧，
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

  // 出图技能：显式指定优先，否则按目标自动检索（只取 appliesTo=still 的）。
  const skills = await pickStillSkills(options.skillIds, target, sheet.name);
  const composed = composeStillPrompt(prompt, skills, bible.style.stylePrefix ?? "");

  const image = await generateImageWithModel({
    prompt: composed,
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
    const appliedSkillIds = await markStillSkillsUsed(skills, project.id, target, id);
    sheet.stillImages = [...new Set([relative, ...(sheet.stillImages ?? [])])].slice(0, 4);
    addAsset(project, { kind: "still", path: relative, label: `${target === "character" ? "定妆照" : "场景照"} ${sheet.name}`, meta: { target, id, model: image.model, backend: image.backend, references: usedReferences, prompt: composed, skillIds: appliedSkillIds } });
    await saveProject(project);
    return {
      target,
      id,
      path: relative,
      source: "model",
      backend: image.backend,
      model: image.model,
      references: usedReferences,
      skillIds: appliedSkillIds,
      note: image.backend === "local"
        ? `本地 GPU 生成${image.seconds ? `，${image.seconds.toFixed(1)}s` : ""}`
        : image.seconds
          ? `${image.backend} 生成，${image.seconds.toFixed(1)}s`
          : undefined,
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
