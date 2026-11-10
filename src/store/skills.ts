import { join } from "node:path";
import { dataDir } from "../config";
import type { Skill, SkillDraft, SkillEvidence, SkillKind, SkillOutcome, SkillStatus } from "../types";
import { ensureDir, exists, listDirs, nowIso, readJsonIfExists, safeJoin, writeJson, writeText } from "../util/fs";

export const skillKinds: SkillKind[] = ["camera", "lighting", "color", "composition", "rhythm", "prompt", "sound", "workflow", "avoid"];

let cache: Skill[] | undefined;

export function skillsDir() {
  return join(dataDir, "skills");
}

export function skillDir(id: string) {
  if (!/^[\p{L}\p{N}_.-]+$/u.test(id)) throw new Error("非法技能 ID");
  return join(skillsDir(), id);
}

export function skillJsonPath(id: string) {
  return join(skillDir(id), "skill.json");
}

export function skillMarkdownPath(id: string) {
  return join(skillDir(id), "SKILL.md");
}

export function invalidateSkillsCache() {
  cache = undefined;
}

export async function listSkills(force = false): Promise<Skill[]> {
  if (cache && !force) return cache;
  const ids = await listDirs(skillsDir());
  const skills = await Promise.all(ids.map(id => readJsonIfExists<Skill>(join(skillsDir(), id, "skill.json"))));
  cache = skills
    .filter((skill): skill is Skill => Boolean(skill?.id && skill.name))
    .sort((left, right) => {
      const rank = (status: SkillStatus) => (status === "active" ? 0 : status === "candidate" ? 1 : 2);
      return rank(left.status) - rank(right.status) || right.confidence - left.confidence || right.updatedAt.localeCompare(left.updatedAt);
    });
  return cache;
}

export async function getSkill(id: string): Promise<Skill> {
  const skill = await readJsonIfExists<Skill>(skillJsonPath(id));
  if (!skill) throw new Error(`技能不存在：${id}`);
  return skill;
}

export async function writeSkill(skill: Skill) {
  skill.updatedAt = nowIso();
  await ensureDir(skillDir(skill.id));
  await writeJson(skillJsonPath(skill.id), skill);
  await writeText(skillMarkdownPath(skill.id), skillToMarkdown(skill));
  invalidateSkillsCache();
  return skill;
}

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

export function computeConfidence(skill: Pick<Skill, "evidence" | "outcomes" | "stats">) {
  const good = skill.stats.good;
  const mixed = skill.stats.mixed;
  const bad = skill.stats.bad;
  const total = good + mixed + bad;
  const evidenceBonus = Math.min(0.25, 0.07 * Math.max(0, skill.evidence.length - 1));
  const outcomeScore = total ? ((good + mixed * 0.5) / total) * 0.4 : 0;
  const usageBonus = Math.min(0.08, skill.stats.used * 0.01);
  return clamp(0.32 + evidenceBonus + outcomeScore + usageBonus);
}

export function refreshSkillState(skill: Skill) {
  skill.confidence = Number(computeConfidence(skill).toFixed(2));
  if (skill.statusLocked || skill.mergedInto) return skill;
  const { good, mixed, bad } = skill.stats;
  if (bad >= 2 && bad > good + mixed) skill.status = "deprecated";
  else if (good >= 1 || skill.evidence.length >= 3 || skill.confidence >= 0.6) skill.status = "active";
  else skill.status = "candidate";
  return skill;
}

function tokens(text: string) {
  const raw = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const result = new Set(raw);
  for (const token of raw) {
    if (/[\u3400-\u9fff]/.test(token) && token.length > 2) {
      for (let index = 0; index < token.length - 1; index++) result.add(token.slice(index, index + 2));
    }
  }
  return result;
}

function jaccard(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection++;
  return intersection / (left.size + right.size - intersection);
}

export function skillSimilarity(draft: SkillDraft, skill: Skill) {
  if (draft.kind !== skill.kind) return 0;
  const tagScore = jaccard(tokens(draft.tags.join(" ")), tokens(skill.tags.join(" ")));
  const textScore = jaccard(
    tokens(`${draft.name} ${draft.summaryZh} ${draft.instruction} ${draft.applicableWhen.join(" ")}`),
    tokens(`${skill.name} ${skill.summaryZh} ${skill.instruction} ${skill.applicableWhen.join(" ")}`),
  );
  const fragmentScore = jaccard(tokens(draft.promptFragment), tokens(skill.promptFragment));
  return Math.max(0.55 * tagScore + 0.45 * textScore, 0.75 * fragmentScore + 0.25 * tagScore);
}

export function findBestMatch(draft: SkillDraft, skills: Skill[], threshold = 0.52) {
  let best: Skill | undefined;
  let bestScore = 0;
  for (const skill of skills) {
    if (skill.status === "deprecated") continue;
    const score = skillSimilarity(draft, skill);
    if (score > bestScore) {
      bestScore = score;
      best = skill;
    }
  }
  return bestScore >= threshold ? { skill: best as Skill, score: bestScore } : undefined;
}

function cleanText(value: unknown, max: number, fallback = "") {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return (text || fallback).slice(0, max);
}

function cleanList(value: unknown, limit: number, itemMax = 80) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map(item => item.replace(/\s+/g, " ").trim().slice(0, itemMax)).filter(Boolean))].slice(0, limit);
}

export function normalizeDraft(raw: unknown): SkillDraft | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const kind = skillKinds.includes(value.kind as SkillKind) ? (value.kind as SkillKind) : undefined;
  if (!kind) return undefined;
  const name = cleanText(value.name, 80);
  const summaryZh = cleanText(value.summaryZh, 240);
  const instruction = cleanText(value.instruction, 1400, summaryZh);
  const promptFragment = cleanText(value.promptFragment, 1400);
  if (!name || (!instruction && !promptFragment)) return undefined;
  const tags = cleanList(value.tags, 10, 32);
  return {
    name,
    kind,
    summaryZh,
    instruction,
    promptFragment,
    applicableWhen: cleanList(value.applicableWhen, 8, 48),
    avoidWhen: cleanList(value.avoidWhen, 6, 48),
    tags: tags.length ? tags : [kind],
    evidenceShotIds: cleanList(value.evidenceShotIds, 6, 16),
    confidence: typeof value.confidence === "number" ? clamp(value.confidence) : undefined,
  };
}

export function newSkillId(draft: SkillDraft) {
  const hash = Bun.hash(`${draft.kind}:${draft.name.toLowerCase()}`).toString(16).slice(0, 8);
  return `${draft.kind}-${hash}`;
}

export function createSkillFromDraft(draft: SkillDraft, evidence: SkillEvidence[]): Skill {
  const now = nowIso();
  const skill: Skill = {
    id: newSkillId(draft),
    name: draft.name,
    kind: draft.kind,
    status: "candidate",
    summaryZh: draft.summaryZh,
    instruction: draft.instruction,
    promptFragment: draft.promptFragment,
    applicableWhen: draft.applicableWhen,
    avoidWhen: draft.avoidWhen,
    tags: draft.tags,
    evidence,
    outcomes: [],
    stats: { used: 0, reads: 0, good: 0, mixed: 0, bad: 0 },
    confidence: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
    revisions: [],
  };
  refreshSkillState(skill);
  // ACT: 模型自评只作为候选排序参考，不直接抬高置信度；置信度由独立证据与真实反馈累积。
  skill.revisions.push({ version: 1, at: now, change: "从参考片抽取", confidence: skill.confidence });
  return skill;
}

function evidenceKey(evidence: SkillEvidence) {
  return `${evidence.projectId}:${[...evidence.shotIds].sort().join(",")}`;
}

export function mergeDraftIntoSkill(skill: Skill, draft: SkillDraft, evidence: SkillEvidence[]) {
  let changed = false;
  const union = (current: string[], incoming: string[], limit: number) => {
    const next = [...new Set([...current, ...incoming])].slice(0, limit);
    if (next.length !== current.length) changed = true;
    return next;
  };
  skill.tags = union(skill.tags, draft.tags, 10);
  skill.applicableWhen = union(skill.applicableWhen, draft.applicableWhen, 8);
  skill.avoidWhen = union(skill.avoidWhen, draft.avoidWhen, 6);
  if (!skill.summaryZh) {
    skill.summaryZh = draft.summaryZh;
    changed = true;
  }
  if (!skill.instruction) {
    skill.instruction = draft.instruction;
    changed = true;
  }
  if (draft.promptFragment.length > skill.promptFragment.length + 20) {
    skill.promptFragment = draft.promptFragment;
    changed = true;
  }
  const keys = new Set(skill.evidence.map(evidenceKey));
  for (const item of evidence) {
    if (keys.has(evidenceKey(item))) continue;
    skill.evidence.push(item);
    changed = true;
  }
  skill.evidence = skill.evidence.slice(-12);
  refreshSkillState(skill);
  if (changed) {
    skill.version += 1;
    skill.revisions.push({ version: skill.version, at: nowIso(), change: `新增证据：${evidence.map(item => item.projectTitle).join("、") || "无"}`, confidence: skill.confidence });
    skill.revisions = skill.revisions.slice(-20);
  }
  return changed;
}

const kindHints: Record<string, SkillKind> = {
  灯光: "lighting",
  布光: "lighting",
  运镜: "camera",
  镜头运动: "camera",
  构图: "composition",
  节奏: "rhythm",
  剪辑: "rhythm",
  调色: "color",
  色彩: "color",
  声音: "sound",
  音乐: "sound",
  提示词: "prompt",
  避坑: "avoid",
  流程: "workflow",
};

export async function searchSkills(query: string, options: { kind?: SkillKind; limit?: number; includeDeprecated?: boolean } = {}) {
  const skills = await listSkills();
  const text = query.trim().toLowerCase();
  const queryTokens = tokens(text);
  const hintedKinds = new Set(Object.entries(kindHints).filter(([word]) => text.includes(word)).map(([, kind]) => kind));
  const limit = Math.min(50, Math.max(1, options.limit ?? 8));
  const scored = skills
    .filter(skill => (!options.kind || skill.kind === options.kind) && (options.includeDeprecated || skill.status !== "deprecated"))
    .map(skill => {
      let score = 0;
      let hits = 0;
      if (text) {
        for (const token of queryTokens) {
          let tokenHit = false;
          if (skill.tags.some(tag => tag.toLowerCase().includes(token))) { score += 4; tokenHit = true; }
          if (skill.name.toLowerCase().includes(token)) { score += 3; tokenHit = true; }
          if (skill.summaryZh.toLowerCase().includes(token)) { score += 2; tokenHit = true; }
          if (skill.applicableWhen.some(item => item.toLowerCase().includes(token))) { score += 2; tokenHit = true; }
          if (skill.instruction.toLowerCase().includes(token)) { score += 1; tokenHit = true; }
          if (skill.promptFragment.toLowerCase().includes(token)) { score += 1; tokenHit = true; }
          if (tokenHit) hits += 1;
        }
      }
      score += (skill.status === "active" ? 1.5 : 0) + skill.confidence * 2 + Math.min(1, skill.stats.used * 0.05);
      if (hintedKinds.has(skill.kind)) {
        hits += 1;
        score += 3;
      }
      return { skill, score: Number(score.toFixed(2)), hits };
    })
    .filter(item => !text || item.hits > 0)
    .map(({ skill, score }) => ({ skill, score }))
    .sort((left, right) => right.score - left.score || right.skill.confidence - left.skill.confidence);
  return scored.slice(0, limit);
}

export async function recordSkillOutcome(input: {
  skillId: string;
  rating: "good" | "mixed" | "bad";
  projectId: string;
  shotId?: string;
  notes?: string;
}) {
  const skill = await getSkill(input.skillId);
  const outcome: SkillOutcome = {
    projectId: input.projectId,
    shotId: input.shotId,
    rating: input.rating,
    notes: cleanText(input.notes, 600) || undefined,
    at: nowIso(),
  };
  skill.outcomes = [...skill.outcomes, outcome].slice(-30);
  skill.stats[input.rating] += 1;
  refreshSkillState(skill);
  await writeSkill(skill);
  return skill;
}

export async function markSkillUsed(id: string, usage: { projectId: string; shotId: string }) {
  const skill = await getSkill(id);
  skill.stats.used += 1;
  skill.stats.lastUsedAt = nowIso();
  skill.evidence = skill.evidence.length
    ? skill.evidence
    : [{ projectId: usage.projectId, projectTitle: usage.projectId, shotIds: [usage.shotId], addedAt: nowIso() }];
  await writeSkill(skill);
  return skill;
}

export async function markSkillRead(id: string) {
  const skill = await getSkill(id);
  skill.stats.reads += 1;
  await writeSkill(skill);
  return skill;
}

export async function updateSkill(id: string, patch: Record<string, unknown>) {
  const skill = await getSkill(id);
  const before = JSON.stringify({ ...skill, revisions: undefined, updatedAt: undefined });
  if (typeof patch.name === "string" && patch.name.trim()) skill.name = cleanText(patch.name, 80);
  if (typeof patch.summaryZh === "string") skill.summaryZh = cleanText(patch.summaryZh, 240);
  if (typeof patch.instruction === "string") skill.instruction = cleanText(patch.instruction, 1400);
  if (typeof patch.promptFragment === "string") skill.promptFragment = cleanText(patch.promptFragment, 1400);
  if (Array.isArray(patch.applicableWhen)) skill.applicableWhen = cleanList(patch.applicableWhen, 8, 48);
  if (Array.isArray(patch.avoidWhen)) skill.avoidWhen = cleanList(patch.avoidWhen, 6, 48);
  if (Array.isArray(patch.tags)) skill.tags = cleanList(patch.tags, 10, 32);
  if (typeof patch.status === "string" && ["candidate", "active", "deprecated"].includes(patch.status)) {
    skill.status = patch.status as SkillStatus;
    skill.statusLocked = true;
  }
  const after = JSON.stringify({ ...skill, revisions: undefined, updatedAt: undefined });
  if (after !== before) {
    skill.version += 1;
    skill.revisions.push({ version: skill.version, at: nowIso(), change: "人工修正", confidence: skill.confidence });
    skill.revisions = skill.revisions.slice(-20);
  }
  refreshSkillState(skill);
  await writeSkill(skill);
  return skill;
}

export async function mergeSkills(sourceId: string, targetId: string) {
  if (sourceId === targetId) throw new Error("不能合并到自己");
  const source = await getSkill(sourceId);
  const target = await getSkill(targetId);
  const union = (left: string[], right: string[], limit: number) => [...new Set([...left, ...right])].slice(0, limit);
  target.tags = union(target.tags, source.tags, 10);
  target.applicableWhen = union(target.applicableWhen, source.applicableWhen, 8);
  target.avoidWhen = union(target.avoidWhen, source.avoidWhen, 6);
  if (source.promptFragment.length > target.promptFragment.length) target.promptFragment = source.promptFragment;
  const keys = new Set(target.evidence.map(evidenceKey));
  for (const item of source.evidence) if (!keys.has(evidenceKey(item))) target.evidence.push(item);
  target.evidence = target.evidence.slice(-12);
  target.outcomes = [...target.outcomes, ...source.outcomes].slice(-30);
  for (const key of ["used", "reads", "good", "mixed", "bad"] as const) target.stats[key] += source.stats[key];
  target.version += 1;
  refreshSkillState(target);
  target.revisions.push({ version: target.version, at: nowIso(), change: `合并技能 ${source.id}`, confidence: target.confidence });
  target.revisions = target.revisions.slice(-20);
  await writeSkill(target);

  source.status = "deprecated";
  source.statusLocked = true;
  source.mergedInto = target.id;
  source.revisions.push({ version: source.version, at: nowIso(), change: `并入 ${target.id}`, confidence: source.confidence });
  await writeSkill(source);
  return { target, source };
}

export function skillToSummary(skill: Skill) {
  return {
    id: skill.id,
    name: skill.name,
    kind: skill.kind,
    status: skill.status,
    confidence: skill.confidence,
    summaryZh: skill.summaryZh,
    applicableWhen: skill.applicableWhen,
    tags: skill.tags,
    version: skill.version,
    evidenceCount: skill.evidence.length,
    images: skill.evidence.map(item => item.image).filter((image): image is string => Boolean(image)).slice(-2),
    used: skill.stats.used,
    good: skill.stats.good,
    mixed: skill.stats.mixed,
    bad: skill.stats.bad,
    updatedAt: skill.updatedAt,
  };
}

export function skillToMarkdown(skill: Skill) {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`id: ${skill.id}`);
  lines.push(`name: ${skill.name}`);
  lines.push(`kind: ${skill.kind}`);
  lines.push(`status: ${skill.status}`);
  lines.push(`confidence: ${skill.confidence}`);
  lines.push(`version: ${skill.version}`);
  lines.push(`tags: ${skill.tags.join(", ")}`);
  lines.push(`updatedAt: ${skill.updatedAt}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${skill.name}`);
  lines.push("");
  lines.push(skill.summaryZh || "");
  lines.push("");
  lines.push("## 何时使用");
  lines.push(skill.applicableWhen.length ? skill.applicableWhen.map(item => `- ${item}`).join("\n") : "- 未限定");
  if (skill.avoidWhen.length) {
    lines.push("");
    lines.push("## 避免使用");
    lines.push(skill.avoidWhen.map(item => `- ${item}`).join("\n"));
  }
  lines.push("");
  lines.push("## 执行规则");
  lines.push(skill.instruction || "-");
  lines.push("");
  lines.push("## H3 prompt fragment");
  lines.push("```text");
  lines.push(skill.promptFragment || "N/A");
  lines.push("```");
  lines.push("");
  lines.push("## 证据");
  if (!skill.evidence.length) lines.push("- 暂无");
  for (const item of skill.evidence) {
    lines.push(`- ${item.projectTitle}（${item.projectId}）镜头 ${item.shotIds.join("、") || "-"}${item.sourceName ? ` · ${item.sourceName}` : ""}`);
    if (item.image) lines.push(`  ![evidence](${item.image})`);
    if (item.note) lines.push(`  - ${item.note}`);
  }
  lines.push("");
  lines.push("## 使用与反馈");
  lines.push(`- 使用 ${skill.stats.used} 次，阅读 ${skill.stats.reads} 次`);
  lines.push(`- 好评 ${skill.stats.good} / 一般 ${skill.stats.mixed} / 差评 ${skill.stats.bad}`);
  const recent = skill.outcomes.slice(-5);
  for (const outcome of recent) {
    lines.push(`- ${outcome.at.slice(0, 10)} ${outcome.rating}${outcome.shotId ? ` · ${outcome.shotId}` : ""}${outcome.notes ? `：${outcome.notes}` : ""}`);
  }
  lines.push("");
  lines.push("## 修订历史");
  for (const revision of skill.revisions.slice(-8)) {
    lines.push(`- v${revision.version} · ${revision.at.slice(0, 10)} · ${revision.change}（置信度 ${revision.confidence}）`);
  }
  return `${lines.join("\n")}\n`;
}

export function skillEvidenceFile(skillId: string, relative: string) {
  return safeJoin(skillDir(skillId), relative);
}

export { exists };
