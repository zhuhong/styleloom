import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../config";
import type { Project, StyleBible } from "../types";
import { ensureDir, exists, listFiles, nowIso, readJsonIfExists, writeJson } from "../util/fs";
import { projectDir } from "./projects";

export type StylePackShot = { id: string; duration: number; keyframe: string; clip?: string };

export type StylePack = {
  id: string;
  title: string;
  createdAt: string;
  sourceProjectId: string;
  sourceName?: string;
  bible: StyleBible;
  shots: StylePackShot[];
};

export type StylePackSummary = {
  id: string;
  title: string;
  summary: string;
  createdAt: string;
  sourceName?: string;
  shotCount: number;
  characters: string[];
  locations: string[];
  cameraMoves: string[];
};

export function packsDir() {
  return join(dataDir, "library", "packs");
}

export async function saveStylePack(project: Project, shots: StylePackShot[]) {
  if (!project.styleBible) throw new Error("项目还没有风格圣经，无法保存风格包");
  const pack: StylePack = {
    id: project.id,
    title: project.title,
    createdAt: nowIso(),
    sourceProjectId: project.id,
    sourceName: project.styleBible.source.sourceName,
    bible: project.styleBible,
    shots,
  };
  await writeJson(join(packsDir(), `${pack.id}.json`), pack);
  project.libraryPackId = pack.id;
  return pack;
}

export async function listStylePacks(): Promise<StylePackSummary[]> {
  const files = await listFiles(packsDir(), ".json");
  const packs = await Promise.all(files.map(file => readJsonIfExists<StylePack>(file)));
  return packs
    .filter((pack): pack is StylePack => Boolean(pack))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(pack => ({
      id: pack.id,
      title: pack.title,
      summary: pack.bible.summary,
      createdAt: pack.createdAt,
      sourceName: pack.sourceName,
      shotCount: pack.bible.source.shotCount,
      characters: pack.bible.characters.map(character => character.name),
      locations: pack.bible.locations.map(location => location.name),
      cameraMoves: pack.bible.cameraGrammar.map(move => move.name),
    }));
}

export async function loadStylePack(id: string): Promise<StylePack> {
  if (!/^[\p{L}\p{N}_.-]+$/u.test(id)) throw new Error("非法风格包 ID");
  const pack = await readJsonIfExists<StylePack>(join(packsDir(), `${id}.json`));
  if (!pack) throw new Error(`风格包不存在：${id}`);
  return pack;
}

function referencedFiles(bible: StyleBible, shots: StylePackShot[]) {
  const files = new Set<string>();
  for (const character of bible.characters) {
    for (const path of [...character.refImages, ...character.stillImages]) files.add(path);
  }
  for (const location of bible.locations) {
    for (const path of [...location.refImages, ...location.stillImages]) files.add(path);
  }
  const shotIds = new Set(bible.cameraGrammar.flatMap(move => move.exampleShotIds));
  for (const shot of shots) {
    if (!shotIds.has(shot.id)) continue;
    files.add(shot.keyframe);
    if (shot.clip) files.add(shot.clip);
  }
  return files;
}

/** 把风格包引用的图片/片段复制进当前项目，并重写相对路径。 */
export async function applyStylePack(project: Project, packId: string) {
  const pack = await loadStylePack(packId);
  const sourceRoot = projectDir(pack.sourceProjectId);
  const targetRoot = projectDir(project.id);
  const prefix = `library/${pack.id}`;
  const mapping = new Map<string, string>();
  for (const relativePath of referencedFiles(pack.bible, pack.shots)) {
    const from = join(sourceRoot, relativePath);
    if (!(await exists(from))) continue;
    const target = join(targetRoot, prefix, relativePath);
    await ensureDir(join(target, ".."));
    await copyFile(from, target);
    mapping.set(relativePath, `${prefix}/${relativePath}`);
  }
  const rewrite = (path: string) => mapping.get(path) ?? "";
  const bible: StyleBible = structuredClone(pack.bible);
  bible.createdAt = pack.bible.createdAt;
  bible.source = { ...bible.source, projectId: project.id, projectTitle: project.title };
  for (const character of bible.characters) {
    character.refImages = character.refImages.map(rewrite).filter(Boolean);
    character.stillImages = character.stillImages.map(rewrite).filter(Boolean);
  }
  for (const location of bible.locations) {
    location.refImages = location.refImages.map(rewrite).filter(Boolean);
    location.stillImages = location.stillImages.map(rewrite).filter(Boolean);
  }
  project.styleBible = bible;
  project.libraryPackId = pack.id;
  return { bible, copied: mapping.size };
}
