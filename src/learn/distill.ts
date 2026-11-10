import { join } from "node:path";
import type {
  CameraMove,
  CharacterSheet,
  LocationSheet,
  Project,
  SliceManifest,
  StyleBible,
} from "../types";
import type { Settings } from "../config";
import { chatJson } from "../providers/llm";
import { projectDir } from "../store/projects";
import { nowIso, writeJson, writeText } from "../util/fs";

export type DistillResult = { bible: StyleBible; warning?: string };

type Raw = Record<string, unknown>;

const systemPrompt = `你是影视风格分析师，任务是把逐镜头拉片记录归纳成可复用的「风格圣经」，供后续视频生成复用。
只输出一个 JSON 对象，不要 Markdown 或解释。字段要求：
- summary、descriptionZh、rhythm.cutPattern、rhythm.notes 使用中文；其余面向生成提示词的字段使用英文。
- 只基于给出的观察记录，不编造未出现的角色、地点或运镜。
- refShotIds / exampleShotIds 必须来自输入中真实存在的镜头 id。
- characters 只收录有辨识度的主体；locations 只收录可复用的场景；cameraGrammar 只收录确实出现过的运镜。
JSON 结构：
{
  "summary": "中文整体风格概述，300字内",
  "style": {
    "genre": "English", "filmLook": "English", "colorGrade": "English", "lighting": "English",
    "lensPackage": "English", "aspectRatio": "16:9", "texture": "English",
    "stylePrefix": "English single-sentence style prefix for every generation"
  },
  "characters": [{
    "name": "中文称呼", "descriptionZh": "中文", "identity": "English identity anchor",
    "wardrobe": "English", "distinctiveFeatures": ["English"], "refShotIds": ["s01"],
    "stillPrompt": "English prompt describing a neutral reference still of this character"
  }],
  "locations": [{
    "name": "中文", "descriptionZh": "中文", "promptEn": "English location reference prompt",
    "timeOfDay": "English", "lighting": "English", "refShotIds": ["s01"]
  }],
  "cameraGrammar": [{
    "name": "English move name", "descriptionZh": "中文", "amplitude": "small/medium/large",
    "speed": "slow/measured/fast", "motivation": "English", "promptFragment": "English",
    "exampleShotIds": ["s02"]
  }],
  "rhythm": { "averageShotSeconds": 0, "cutPattern": "中文", "notes": "中文" },
  "prompting": {
    "consistencyAnchors": ["English"], "avoid": ["English"], "promptPatterns": ["English"]
  },
  "sound": { "ambience": "English", "music": "English", "mixNotes": "English" }
}`;

function str(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function strings(value: unknown, limit = 8) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map(item => item.trim()).filter(Boolean).slice(0, limit)
    : [];
}

function frequency(values: string[], limit = 5) {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, limit).map(([value]) => value);
}

function shotIndex(manifest: SliceManifest) {
  return new Map(manifest.shots.map(shot => [shot.id, shot]));
}

function normalizeShotIds(value: unknown, manifest: SliceManifest) {
  const index = shotIndex(manifest);
  const ids = strings(value, 8).map(id => (id.startsWith("s") ? id : `s${id.padStart(2, "0")}`));
  return [...new Set(ids.filter(id => index.has(id)))];
}

function refImages(ids: string[], manifest: SliceManifest, limit = 3) {
  const index = shotIndex(manifest);
  return [...new Set(ids.map(id => index.get(id)?.keyframe).filter((path): path is string => Boolean(path)))].slice(0, limit);
}

function matchShots(text: string, manifest: SliceManifest, limit = 2) {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 3);
  const scored = manifest.shots
    .map(shot => {
      const haystack = `${shot.annotation?.subject ?? ""} ${shot.annotation?.wardrobe ?? ""} ${shot.annotation?.setting ?? ""}`.toLowerCase();
      const score = tokens.reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0);
      return { shot, score };
    })
    .filter(item => item.score >= 2)
    .sort((left, right) => right.score - left.score);
  return scored.slice(0, limit).map(item => item.shot.id);
}

function fallbackBible(manifest: SliceManifest, project: Project): StyleBible {
  const annotations = manifest.shots.map(shot => shot.annotation).filter((annotation): annotation is NonNullable<typeof annotation> => Boolean(annotation));
  const tags = frequency(annotations.flatMap(annotation => annotation.styleTags), 4);
  const movements = frequency(annotations.map(annotation => annotation.movement), 6).filter(move => move && !move.includes("unable"));
  const subjects = frequency(annotations.map(annotation => annotation.subject), 4);
  const settings = frequency(annotations.map(annotation => annotation.setting), 4);
  const wardrobe = frequency(annotations.map(annotation => annotation.wardrobe), 3);
  const palette = frequency(annotations.map(annotation => annotation.palette), 2);
  const average = manifest.shots.length ? manifest.duration / manifest.shots.length : 0;
  const stylePrefix = `Cinematic live-action with ${tags.join(", ") || "natural color"}, ${palette.join("; ") || "restrained color separation"} and consistent directional lighting.`;
  return {
    version: 1,
    createdAt: nowIso(),
    source: {
      projectId: project.id,
      projectTitle: project.title,
      sourceName: manifest.sourceName,
      shotCount: manifest.shots.length,
      durationSeconds: manifest.duration,
    },
    summary: `参考片共 ${manifest.shots.length} 个镜头、${manifest.duration.toFixed(1)} 秒，平均镜头长度 ${average.toFixed(2)} 秒。画面风格关键词：${tags.join("、") || "未识别"}。`,
    style: {
      genre: "live-action",
      filmLook: tags[0] ?? "cinematic realism",
      colorGrade: palette[0] ?? "natural color",
      lighting: annotations[0]?.lighting ?? "motivated directional lighting",
      lensPackage: annotations[0]?.lens ?? "35mm and 50mm",
      aspectRatio: manifest.width >= manifest.height ? "16:9" : "9:16",
      texture: "natural skin texture, subtle grain",
      stylePrefix,
    },
    characters: subjects.map((subject, index) => ({
      id: `c${index + 1}`,
      name: `角色${index + 1}`,
      descriptionZh: `参考片中反复出现的主体：${subject}`,
      identity: subject,
      wardrobe: wardrobe[0] ?? "",
      distinctiveFeatures: [],
      refShotIds: matchShots(subject, manifest, 2),
      refImages: [],
      stillImages: [],
      stillPrompt: `${subject}, ${wardrobe[0] ?? ""}, neutral full-body reference still, plain seamless background, ${stylePrefix}`,
    })),
    locations: settings.map((setting, index) => ({
      id: `l${index + 1}`,
      name: `场景${index + 1}`,
      descriptionZh: `参考片场景：${setting}`,
      promptEn: `${setting}, ${stylePrefix}`,
      timeOfDay: "",
      lighting: annotations[0]?.lighting ?? "",
      refShotIds: matchShots(setting, manifest, 2),
      refImages: [],
      stillImages: [],
      stillPrompt: `${setting}, empty location reference still, ${stylePrefix}`,
    })),
    cameraGrammar: movements.map((movement, index) => ({
      name: movement,
      descriptionZh: movement,
      amplitude: "medium",
      speed: "measured",
      motivation: "",
      promptFragment: movement,
      exampleShotIds: manifest.shots.filter(shot => shot.annotation?.movement === movement).slice(0, 3).map(shot => shot.id),
    })),
    rhythm: {
      averageShotSeconds: Number(average.toFixed(2)),
      shotCount: manifest.shots.length,
      cutPattern: "按本地检测结果统计，未做人工归纳",
      notes: `最长镜头 ${Math.max(...manifest.shots.map(shot => shot.duration)).toFixed(2)} 秒，最短 ${Math.min(...manifest.shots.map(shot => shot.duration)).toFixed(2)} 秒。`,
    },
    prompting: {
      consistencyAnchors: [...new Set([...wardrobe, ...settings])].slice(0, 6),
      avoid: ["identity drift", "wardrobe color change", "unmotivated camera shake", "background layout change"],
      promptPatterns: [stylePrefix],
    },
    sound: {
      ambience: annotations[0]?.sound ?? "",
      music: "N/A",
      mixNotes: "Keep ambience continuous across cuts.",
    },
  };
}

function ensureBible(raw: Raw, fallback: StyleBible, manifest: SliceManifest, project: Project): StyleBible {
  const styleRaw = (raw.style && typeof raw.style === "object" ? raw.style : {}) as Raw;
  const style = fallback.style;
  const bible: StyleBible = {
    version: 1,
    createdAt: nowIso(),
    source: {
      projectId: project.id,
      projectTitle: project.title,
      sourceName: manifest.sourceName,
      shotCount: manifest.shots.length,
      durationSeconds: manifest.duration,
    },
    summary: str(raw.summary, fallback.summary),
    style: {
      genre: str(styleRaw.genre, style.genre),
      filmLook: str(styleRaw.filmLook, style.filmLook),
      colorGrade: str(styleRaw.colorGrade, style.colorGrade),
      lighting: str(styleRaw.lighting, style.lighting),
      lensPackage: str(styleRaw.lensPackage, style.lensPackage),
      aspectRatio: str(styleRaw.aspectRatio, style.aspectRatio),
      texture: str(styleRaw.texture, style.texture),
      stylePrefix: str(styleRaw.stylePrefix, style.stylePrefix),
    },
    characters: [],
    locations: [],
    cameraGrammar: [],
    rhythm: {
      averageShotSeconds: Number(fallback.rhythm.averageShotSeconds),
      shotCount: manifest.shots.length,
      cutPattern: str((raw.rhythm as Raw | undefined)?.cutPattern, fallback.rhythm.cutPattern),
      notes: str((raw.rhythm as Raw | undefined)?.notes, fallback.rhythm.notes),
    },
    prompting: {
      consistencyAnchors: strings((raw.prompting as Raw | undefined)?.consistencyAnchors, 8),
      avoid: strings((raw.prompting as Raw | undefined)?.avoid, 8),
      promptPatterns: strings((raw.prompting as Raw | undefined)?.promptPatterns, 8),
    },
    sound: {
      ambience: str((raw.sound as Raw | undefined)?.ambience, fallback.sound.ambience),
      music: str((raw.sound as Raw | undefined)?.music, fallback.sound.music),
      mixNotes: str((raw.sound as Raw | undefined)?.mixNotes, fallback.sound.mixNotes),
    },
  };
  if (!bible.prompting.consistencyAnchors.length) bible.prompting.consistencyAnchors = fallback.prompting.consistencyAnchors;
  if (!bible.prompting.avoid.length) bible.prompting.avoid = fallback.prompting.avoid;
  if (!bible.prompting.promptPatterns.length) bible.prompting.promptPatterns = [bible.style.stylePrefix];
  if (!bible.sound.ambience) bible.sound.ambience = fallback.sound.ambience;

  const characters = Array.isArray(raw.characters) ? raw.characters : [];
  bible.characters = characters.slice(0, 6).map((item, index): CharacterSheet => {
    const entry = (item && typeof item === "object" ? item : {}) as Raw;
    const refShotIds = normalizeShotIds(entry.refShotIds, manifest);
    const identity = str(entry.identity, str(entry.descriptionZh, `character ${index + 1}`));
    const resolved = refShotIds.length ? refShotIds : matchShots(identity, manifest, 2);
    return {
      id: `c${index + 1}`,
      name: str(entry.name, `角色${index + 1}`),
      descriptionZh: str(entry.descriptionZh, identity),
      identity,
      wardrobe: str(entry.wardrobe),
      distinctiveFeatures: strings(entry.distinctiveFeatures, 6),
      refShotIds: resolved,
      refImages: refImages(resolved, manifest),
      stillImages: [],
      stillPrompt: str(entry.stillPrompt, `${identity}, ${str(entry.wardrobe)}, neutral full-body reference still, ${bible.style.stylePrefix}`),
    };
  });

  const locations = Array.isArray(raw.locations) ? raw.locations : [];
  bible.locations = locations.slice(0, 6).map((item, index): LocationSheet => {
    const entry = (item && typeof item === "object" ? item : {}) as Raw;
    const promptEn = str(entry.promptEn, str(entry.descriptionZh, `location ${index + 1}`));
    const refShotIds = normalizeShotIds(entry.refShotIds, manifest);
    const resolved = refShotIds.length ? refShotIds : matchShots(promptEn, manifest, 2);
    return {
      id: `l${index + 1}`,
      name: str(entry.name, `场景${index + 1}`),
      descriptionZh: str(entry.descriptionZh, promptEn),
      promptEn,
      timeOfDay: str(entry.timeOfDay),
      lighting: str(entry.lighting),
      refShotIds: resolved,
      refImages: refImages(resolved, manifest),
      stillImages: [],
      stillPrompt: str(entry.stillPrompt, `${promptEn}, empty location reference still, ${bible.style.stylePrefix}`),
    };
  });

  const moves = Array.isArray(raw.cameraGrammar) ? raw.cameraGrammar : [];
  bible.cameraGrammar = moves.slice(0, 10).map((item, index): CameraMove => {
    const entry = (item && typeof item === "object" ? item : {}) as Raw;
    const name = str(entry.name, `camera move ${index + 1}`);
    const exampleShotIds = normalizeShotIds(entry.exampleShotIds, manifest);
    return {
      name,
      descriptionZh: str(entry.descriptionZh, name),
      amplitude: str(entry.amplitude, "medium"),
      speed: str(entry.speed, "measured"),
      motivation: str(entry.motivation),
      promptFragment: str(entry.promptFragment, name),
      exampleShotIds: exampleShotIds.length
        ? exampleShotIds
        : manifest.shots.filter(shot => shot.annotation?.movement.toLowerCase().includes(name.toLowerCase())).slice(0, 3).map(shot => shot.id),
    };
  });

  if (!bible.characters.length) bible.characters = fallback.characters;
  if (!bible.locations.length) bible.locations = fallback.locations;
  if (!bible.cameraGrammar.length) bible.cameraGrammar = fallback.cameraGrammar;
  return bible;
}

export function bibleToMarkdown(bible: StyleBible, manifest: SliceManifest) {
  const lines: string[] = [];
  lines.push(`# 风格圣经 · ${bible.source.projectTitle ?? bible.source.projectId ?? ""}`);
  lines.push("");
  lines.push(`- 来源：${bible.source.sourceName ?? "-"}`);
  lines.push(`- 镜头数：${bible.source.shotCount}　总时长：${bible.source.durationSeconds.toFixed(2)} 秒　平均镜头：${bible.rhythm.averageShotSeconds} 秒`);
  lines.push(`- 生成于：${bible.createdAt}`);
  lines.push("");
  lines.push("## 整体风格");
  lines.push(bible.summary);
  lines.push("");
  lines.push(`**Style prefix**：${bible.style.stylePrefix}`);
  lines.push("");
  lines.push(`- 类型：${bible.style.genre}`);
  lines.push(`- 影像质感：${bible.style.filmLook}`);
  lines.push(`- 调色：${bible.style.colorGrade}`);
  lines.push(`- 灯光：${bible.style.lighting}`);
  lines.push(`- 镜头组：${bible.style.lensPackage}`);
  lines.push(`- 画幅：${bible.style.aspectRatio}`);
  lines.push(`- 纹理：${bible.style.texture}`);
  lines.push("");
  lines.push("## 角色 / 定妆照");
  for (const character of bible.characters) {
    lines.push(`### ${character.name}（${character.id}）`);
    lines.push(character.descriptionZh);
    lines.push(`- 身份锚点：${character.identity}`);
    lines.push(`- 服装：${character.wardrobe || "-"}`);
    lines.push(`- 参考镜头：${character.refShotIds.join("、") || "-"}`);
    lines.push(`- 定妆照提示词：${character.stillPrompt}`);
    lines.push("");
  }
  lines.push("## 场景 / 场景照");
  for (const location of bible.locations) {
    lines.push(`### ${location.name}（${location.id}）`);
    lines.push(location.descriptionZh);
    lines.push(`- 时间/光线：${location.timeOfDay || "-"} / ${location.lighting || "-"}`);
    lines.push(`- 参考镜头：${location.refShotIds.join("、") || "-"}`);
    lines.push(`- 场景照提示词：${location.stillPrompt}`);
    lines.push("");
  }
  lines.push("## 运镜语法");
  for (const move of bible.cameraGrammar) {
    lines.push(`- **${move.name}**（${move.amplitude} / ${move.speed}）：${move.descriptionZh}　例：${move.exampleShotIds.join("、") || "-"}`);
    lines.push(`  - ${move.promptFragment}`);
  }
  lines.push("");
  lines.push("## 节奏与剪辑");
  lines.push(`- 平均镜头长度：${bible.rhythm.averageShotSeconds} 秒`);
  lines.push(`- 切点规律：${bible.rhythm.cutPattern}`);
  lines.push(`- 备注：${bible.rhythm.notes}`);
  lines.push("");
  lines.push("## 提示词约束");
  lines.push(`- 一致性锚点：${bible.prompting.consistencyAnchors.join("；")}`);
  lines.push(`- 必须避免：${bible.prompting.avoid.join("；")}`);
  lines.push(`- 模式：${bible.prompting.promptPatterns.join("；")}`);
  lines.push("");
  lines.push("## 声音");
  lines.push(`- 环境声：${bible.sound.ambience}`);
  lines.push(`- 配乐：${bible.sound.music}`);
  lines.push(`- 混音：${bible.sound.mixNotes}`);
  lines.push("");
  lines.push("## 镜头明细");
  lines.push("| 镜头 | 时间 | 时长 | 景别 | 运镜 | 画面 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const shot of manifest.shots) {
    const annotation = shot.annotation;
    lines.push(`| ${shot.id} | ${shot.start.toFixed(2)}–${shot.end.toFixed(2)} | ${shot.duration.toFixed(2)}s | ${annotation?.shotSize ?? "-"} | ${annotation?.movement ?? "-"} | ${(annotation?.description ?? "").replaceAll("|", "/").slice(0, 90)} |`);
  }
  return `${lines.join("\n")}\n`;
}

/** 把逐镜头标注归纳为风格圣经；失败时退回规则版，保证拉片结果可用。 */
export async function distillStyleBible(options: {
  project: Project;
  manifest: SliceManifest;
  settings: Settings;
  focus?: string;
  signal: AbortSignal;
  onProgress: (percent: number, label: string) => void;
}): Promise<DistillResult> {
  const { project, manifest, settings, signal, onProgress } = options;
  const fallback = fallbackBible(manifest, project);
  onProgress(10, "归纳风格、角色、场景与运镜");
  const observations = manifest.shots.map(shot => ({
    id: shot.id,
    startSeconds: shot.start,
    endSeconds: shot.end,
    durationSeconds: shot.duration,
    ...shot.annotation,
    h3ShotBlock: shot.annotation?.h3ShotBlock.slice(0, 600),
    description: shot.annotation?.description.slice(0, 400),
  }));
  let bible = fallback;
  let warning: string | undefined;
  try {
    const { data } = await chatJson<Raw>({
      system: systemPrompt,
      prompt: `参考片信息：时长 ${manifest.duration.toFixed(2)} 秒，${manifest.width}x${manifest.height}，${manifest.shots.length} 个镜头。
逐镜头观察记录（JSON）：
${JSON.stringify(observations)}
请归纳为风格圣经 JSON。${options.focus ? `\n用户的分析重点：${options.focus}。在 summary 与 prompting 中回应有依据的部分，不编造。` : ""}`,
      model: "text",
      signal,
      timeoutMs: 300_000,
    });
    onProgress(75, "校验归纳结果");
    bible = ensureBible(data, fallback, manifest, project);
  } catch (error) {
    if (signal.aborted) throw error;
    warning = `风格归纳模型调用失败，已使用规则版结果：${error instanceof Error ? error.message : String(error)}`;
  }
  onProgress(88, "写入风格圣经");
  const root = projectDir(project.id);
  await writeJson(join(root, "learning", "styleBible.json"), bible);
  await writeText(join(root, "learning", "styleBible.md"), bibleToMarkdown(bible, manifest));
  onProgress(100, "风格圣经已生成");
  return { bible, warning };
}

export { fallbackBible, ensureBible };
