import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import type { Project, Skill, SkillDraft, SkillEvidence, SliceManifest, StyleBible } from "../types";
import { chatJson } from "../providers/llm";
import { ensureDir, exists, nowIso } from "../util/fs";
import { projectDir } from "../store/projects";
import {
  createSkillFromDraft,
  findBestMatch,
  listSkills,
  mergeDraftIntoSkill,
  newSkillId,
  normalizeDraft,
  skillDir,
  skillToSummary,
  writeSkill,
} from "../store/skills";

export type SkillExtractionResult = {
  created: ReturnType<typeof skillToSummary>[];
  merged: ReturnType<typeof skillToSummary>[];
  total: number;
  warning?: string;
};

const systemPrompt = `你是视频制作技能库的编辑。你的任务是把一次参考片拉片归纳成「可跨项目复用的技能」，而不是描述这部片子。
技能必须是可执行的方法：在别的项目里看到类似场景时，能直接指导分镜、镜头运动、灯光或 H3 提示词。
不要收录具体人物身份、具体公司/项目名、只对这部片成立的细节。
kind 只能取：camera / lighting / color / composition / rhythm / prompt / sound / workflow / avoid。
输出 JSON：{"skills":[{...}]}，最多 8 条，宁少勿滥。
每条技能字段：
{
  "name": "中文短名，24字内",
  "kind": "camera",
  "summaryZh": "中文一句话，60字内",
  "instruction": "中文可执行规则，50-200字，说明何时用、怎么做、做到什么程度",
  "promptFragment": "英文，可直接进入 H3 提示词；纯 workflow/avoid 可为空字符串",
  "applicableWhen": ["3-6个适用条件短语"],
  "avoidWhen": ["0-4个不适用条件"],
  "tags": ["3-8个短标签"],
  "evidenceShotIds": ["s01"],
  "confidence": 0.6
}`;

function fallbackDrafts(bible: StyleBible, manifest: SliceManifest): SkillDraft[] {
  const drafts: SkillDraft[] = [];
  const firstShots = manifest.shots.slice(0, 2).map(shot => shot.id);
  for (const move of bible.cameraGrammar.slice(0, 5)) {
    drafts.push({
      name: move.name.slice(0, 40),
      kind: "camera",
      summaryZh: move.descriptionZh.slice(0, 200),
      instruction: `当分镜需要「${move.descriptionZh.slice(0, 120)}」时使用。幅度 ${move.amplitude}，速度 ${move.speed}，动机：${move.motivation || "服务叙事"}。避免叠加冲突运镜。`,
      promptFragment: move.promptFragment,
      applicableWhen: [move.amplitude, move.speed].filter(Boolean),
      avoidWhen: [],
      tags: ["camera", move.amplitude, move.speed].filter(Boolean),
      evidenceShotIds: move.exampleShotIds.slice(0, 2),
    });
  }
  drafts.push({
    name: "可复用的主光方案",
    kind: "lighting",
    summaryZh: bible.style.lighting.slice(0, 200),
    instruction: `按参考片的布光逻辑执行：${bible.style.lighting}。保持主光方向、色温和阴影逻辑跨镜头连续。`,
    promptFragment: bible.style.lighting,
    applicableWhen: [bible.style.genre].filter(Boolean),
    avoidWhen: [],
    tags: ["lighting", bible.style.genre].filter(Boolean),
    evidenceShotIds: firstShots,
  });
  drafts.push({
    name: "调色与画面质感",
    kind: "color",
    summaryZh: bible.style.colorGrade.slice(0, 200),
    instruction: `调色遵循：${bible.style.colorGrade}。材质与高光按 ${bible.style.texture} 处理。`,
    promptFragment: `${bible.style.colorGrade}. ${bible.style.texture}`,
    applicableWhen: [bible.style.filmLook].filter(Boolean),
    avoidWhen: [],
    tags: ["color", "grade"],
    evidenceShotIds: firstShots,
  });
  drafts.push({
    name: "镜头节奏模板",
    kind: "rhythm",
    summaryZh: `平均 ${bible.rhythm.averageShotSeconds} 秒/镜头；${bible.rhythm.cutPattern}`.slice(0, 200),
    instruction: `参考片节奏：${bible.rhythm.cutPattern}。${bible.rhythm.notes}。拆镜时优先按这个节奏分配时长。`,
    promptFragment: "",
    applicableWhen: ["分镜时长", "剪辑节奏"],
    avoidWhen: [],
    tags: ["rhythm", "editing"],
    evidenceShotIds: manifest.shots.slice(0, 3).map(shot => shot.id),
  });
  drafts.push({
    name: "统一风格前缀",
    kind: "prompt",
    summaryZh: "生成提示词时复用的风格句",
    instruction: "每条 H3 提示词在 [Shot 1] 开头使用该风格句，保证跨镜头风格连续；不要堆叠同义画质词。",
    promptFragment: bible.style.stylePrefix,
    applicableWhen: ["所有生成"],
    avoidWhen: ["动画/监控等非写实风格"],
    tags: ["prompt", "style"],
    evidenceShotIds: firstShots,
  });
  for (const avoid of bible.prompting.avoid.slice(0, 2)) {
    drafts.push({
      name: `避免：${avoid.slice(0, 30)}`,
      kind: "avoid",
      summaryZh: avoid.slice(0, 200),
      instruction: `生成与提示词检查时避免：${avoid}。`,
      promptFragment: "",
      applicableWhen: ["提示词检查"],
      avoidWhen: [avoid],
      tags: ["avoid"],
      evidenceShotIds: firstShots,
    });
  }
  return drafts.slice(0, 8);
}

function compactBible(bible: StyleBible) {
  return {
    summary: bible.summary,
    style: bible.style,
    cameraGrammar: bible.cameraGrammar,
    rhythm: bible.rhythm,
    prompting: bible.prompting,
    sound: bible.sound,
    characters: bible.characters.map(character => ({ name: character.name, identity: character.identity, wardrobe: character.wardrobe })),
    locations: bible.locations.map(location => ({ name: location.name, promptEn: location.promptEn })),
  };
}

async function evidenceFor(
  skillId: string,
  project: Project,
  manifest: SliceManifest,
  draft: SkillDraft,
): Promise<SkillEvidence[]> {
  const valid = (draft.evidenceShotIds ?? []).filter(id => manifest.shots.some(shot => shot.id === id));
  const shotIds = (valid.length ? valid : manifest.shots.slice(0, 2).map(shot => shot.id)).slice(0, 2);
  const evidence: SkillEvidence[] = [];
  for (const shotId of shotIds) {
    const shot = manifest.shots.find(item => item.id === shotId);
    if (!shot) continue;
    const entry: SkillEvidence = {
      projectId: project.id,
      projectTitle: project.title,
      sourceName: manifest.sourceName,
      shotIds: [shot.id],
      addedAt: nowIso(),
    };
    const source = join(projectDir(project.id), shot.keyframe);
    if (await exists(source)) {
      const relative = `evidence/${project.id}-${shot.id}.jpg`;
      const target = join(skillDir(skillId), relative);
      await ensureDir(join(skillDir(skillId), "evidence"));
      await copyFile(source, target);
      entry.image = relative;
    }
    evidence.push(entry);
  }
  return evidence;
}

/** 学习完成后自动抽取技能：LLM 优先，失败退回规则版；同义技能合并证据。 */
export async function extractSkillsFromStudy(options: {
  project: Project;
  manifest: SliceManifest;
  bible: StyleBible;
  signal: AbortSignal;
  onProgress: (percent: number, label: string) => void;
}): Promise<SkillExtractionResult> {
  const { project, manifest, bible, signal, onProgress } = options;
  onProgress(5, "抽取可复用技能");
  let drafts: SkillDraft[] = [];
  let warning: string | undefined;
  try {
    const observations = manifest.shots.slice(0, 30).map(shot => ({
      id: shot.id,
      duration: shot.duration,
      shotSize: shot.annotation?.shotSize,
      cameraAngle: shot.annotation?.cameraAngle,
      movement: shot.annotation?.movement,
      lighting: shot.annotation?.lighting,
      composition: shot.annotation?.composition,
      subject: shot.annotation?.subject,
      wardrobe: shot.annotation?.wardrobe,
      setting: shot.annotation?.setting,
      action: shot.annotation?.action,
      description: shot.annotation?.description?.slice(0, 240),
    }));
    const { data } = await chatJson<{ skills?: unknown[] }>({
      system: systemPrompt,
      prompt: `参考片信息：${manifest.sourceName}，${manifest.duration.toFixed(1)} 秒，${manifest.shots.length} 个镜头。
风格圣经：${JSON.stringify(compactBible(bible))}
逐镜观察：${JSON.stringify(observations)}
请输出技能 JSON。`,
      model: "text",
      signal,
      timeoutMs: 240_000,
    });
    drafts = (data.skills ?? []).map(normalizeDraft).filter((draft): draft is SkillDraft => Boolean(draft)).slice(0, 8);
  } catch (error) {
    if (signal.aborted) throw error;
    warning = `技能抽取模型调用失败，已使用规则版：${error instanceof Error ? error.message : String(error)}`;
  }
  if (!drafts.length) drafts = fallbackDrafts(bible, manifest);
  onProgress(60, `合并 ${drafts.length} 条候选技能`);

  const working = await listSkills();
  const created: Skill[] = [];
  const merged: Skill[] = [];
  for (let index = 0; index < drafts.length; index++) {
    signal.throwIfAborted();
    const draft = drafts[index];
    const skillId = newSkillId(draft);
    const existingById = working.find(skill => skill.id === skillId);
    const match = findBestMatch(draft, working) ?? (existingById ? { skill: existingById, score: 1 } : undefined);
    const evidence = await evidenceFor(skillId, project, manifest, draft);
    if (match) {
      const changed = mergeDraftIntoSkill(match.skill, draft, evidence);
      await writeSkill(match.skill);
      if (changed) merged.push(match.skill);
    } else {
      const skill = createSkillFromDraft(draft, evidence);
      await writeSkill(skill);
      working.push(skill);
      created.push(skill);
    }
    onProgress(60 + Math.round((index + 1) / drafts.length * 35), `已处理技能 ${index + 1}/${drafts.length}`);
  }
  onProgress(100, `新增 ${created.length} 条，更新 ${merged.length} 条`);
  return {
    created: created.map(skillToSummary),
    merged: merged.map(skillToSummary),
    total: working.length,
    warning,
  };
}
