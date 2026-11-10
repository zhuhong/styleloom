import type { CameraMove, CharacterSheet, LocationSheet, StyleBible } from "../types";
import { nowIso } from "../util/fs";

type Raw = Record<string, unknown>;

function record(value: unknown): Raw {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Raw : {};
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function strings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map(item => item.trim())
    : [];
}

function number(value: unknown, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

/**
 * 兼容手写/旧版风格圣经：补齐缺失数组与对象。
 * 例如角色只写了 identity、没有 stillImages，旧代码读 .length 会直接崩。
 */
export function normalizeStyleBible(bible: StyleBible): StyleBible {
  if (!bible || typeof bible !== "object") return bible;
  const raw = bible as unknown as Raw;
  const style = record(raw.style);
  const source = record(raw.source);
  const rhythm = record(raw.rhythm);
  const prompting = record(raw.prompting);
  const sound = record(raw.sound);

  bible.version = 1;
  bible.createdAt = text(raw.createdAt, nowIso());
  bible.summary = text(raw.summary);
  bible.source = {
    projectId: typeof source.projectId === "string" ? source.projectId : undefined,
    projectTitle: typeof source.projectTitle === "string" ? source.projectTitle : undefined,
    sourceName: typeof source.sourceName === "string" ? source.sourceName : undefined,
    shotCount: number(source.shotCount),
    durationSeconds: number(source.durationSeconds),
  };
  bible.style = {
    genre: text(style.genre),
    filmLook: text(style.filmLook),
    colorGrade: text(style.colorGrade),
    lighting: text(style.lighting),
    lensPackage: text(style.lensPackage),
    aspectRatio: text(style.aspectRatio),
    texture: text(style.texture),
    stylePrefix: text(style.stylePrefix),
  };

  const characters = Array.isArray(raw.characters) ? raw.characters : [];
  bible.characters = characters.filter(item => item && typeof item === "object").map((item, index): CharacterSheet => {
    const entry = record(item);
    const identity = text(entry.identity, text(entry.descriptionZh, `character ${index + 1}`));
    const descriptionZh = text(entry.descriptionZh, identity);
    const wardrobe = text(entry.wardrobe);
    return {
      id: text(entry.id, `c${index + 1}`),
      name: text(entry.name, `角色${index + 1}`),
      descriptionZh,
      identity,
      wardrobe,
      distinctiveFeatures: strings(entry.distinctiveFeatures),
      refShotIds: strings(entry.refShotIds),
      refImages: strings(entry.refImages),
      stillImages: strings(entry.stillImages),
      stillPrompt: text(entry.stillPrompt, `${identity}${wardrobe ? `, ${wardrobe}` : ""}, neutral reference still`),
    };
  });

  const locations = Array.isArray(raw.locations) ? raw.locations : [];
  bible.locations = locations.filter(item => item && typeof item === "object").map((item, index): LocationSheet => {
    const entry = record(item);
    const promptEn = text(entry.promptEn, text(entry.descriptionZh, `location ${index + 1}`));
    return {
      id: text(entry.id, `l${index + 1}`),
      name: text(entry.name, `场景${index + 1}`),
      descriptionZh: text(entry.descriptionZh, promptEn),
      promptEn,
      timeOfDay: text(entry.timeOfDay),
      lighting: text(entry.lighting),
      refShotIds: strings(entry.refShotIds),
      refImages: strings(entry.refImages),
      stillImages: strings(entry.stillImages),
      stillPrompt: text(entry.stillPrompt, `${promptEn}, empty location reference still`),
    };
  });

  const moves = Array.isArray(raw.cameraGrammar) ? raw.cameraGrammar : [];
  bible.cameraGrammar = moves.filter(item => item && typeof item === "object").map((item, index): CameraMove => {
    const entry = record(item);
    const name = text(entry.name, `camera move ${index + 1}`);
    return {
      name,
      descriptionZh: text(entry.descriptionZh, name),
      amplitude: text(entry.amplitude, "medium"),
      speed: text(entry.speed, "measured"),
      motivation: text(entry.motivation),
      promptFragment: text(entry.promptFragment, name),
      exampleShotIds: strings(entry.exampleShotIds),
    };
  });

  bible.rhythm = {
    averageShotSeconds: number(rhythm.averageShotSeconds),
    shotCount: number(rhythm.shotCount, bible.source.shotCount),
    cutPattern: text(rhythm.cutPattern),
    notes: text(rhythm.notes),
  };
  bible.prompting = {
    consistencyAnchors: strings(prompting.consistencyAnchors),
    avoid: strings(prompting.avoid),
    promptPatterns: strings(prompting.promptPatterns),
  };
  bible.sound = {
    ambience: text(sound.ambience),
    music: text(sound.music),
    mixNotes: text(sound.mixNotes),
  };
  return bible;
}
