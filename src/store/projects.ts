import { join } from "node:path";
import { dataDir } from "../config";
import type { AssetRecord, LearningState, Project, ProjectSummary, SliceManifest } from "../types";
import { exists, ensureDir, listDirs, nowIso, readJsonIfExists, slugify, writeJson } from "../util/fs";

export function projectsDir() {
  return join(dataDir, "projects");
}

export function projectDir(id: string) {
  return join(projectsDir(), id);
}

export function projectFile(id: string) {
  return join(projectDir(id), "project.json");
}

export function sessionFile(id: string) {
  return join(projectDir(id), "session.json");
}

export function manifestFile(id: string) {
  return join(projectDir(id), "learning", "slice.json");
}

export function emptyLearning(): LearningState {
  return { status: "none" };
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const ids = await listDirs(projectsDir());
  const projects = await Promise.all(ids.map(id => readJsonIfExists<Project>(projectFile(id))));
  return projects
    .filter((project): project is Project => Boolean(project))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(project => ({
      id: project.id,
      title: project.title,
      stage: project.stage,
      updatedAt: project.updatedAt,
      shotCount: project.plan.length,
      learning: project.learning.status,
      hasBible: Boolean(project.styleBible),
    }));
}

export async function createProject(title: string): Promise<Project> {
  const cleanTitle = title.trim() || "未命名项目";
  const id = `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${slugify(cleanTitle, "project")}-${crypto.randomUUID().slice(0, 4)}`;
  const now = nowIso();
  const project: Project = {
    id,
    title: cleanTitle,
    createdAt: now,
    updatedAt: now,
    stage: "brief",
    brief: { idea: "", mustKeep: [], avoid: [] },
    learning: emptyLearning(),
    plan: [],
    assets: [],
  };
  await ensureDir(projectDir(id));
  await saveProject(project);
  return project;
}

export async function getProject(id: string): Promise<Project> {
  if (!/^[\p{L}\p{N}_.-]+$/u.test(id)) throw new Error("非法项目 ID");
  const project = await readJsonIfExists<Project>(projectFile(id));
  if (!project) throw new Error(`项目不存在：${id}`);
  project.brief ??= { idea: "", mustKeep: [], avoid: [] };
  project.brief.mustKeep ??= [];
  project.brief.avoid ??= [];
  project.plan ??= [];
  project.assets ??= [];
  project.learning ??= emptyLearning();
  return project;
}

export async function saveProject(project: Project) {
  project.updatedAt = nowIso();
  await writeJson(projectFile(project.id), project);
  return project;
}

export async function getManifest(project: Project): Promise<SliceManifest | undefined> {
  return readJsonIfExists<SliceManifest>(manifestFile(project.id));
}

export async function saveManifest(project: Project, manifest: SliceManifest) {
  await writeJson(manifestFile(project.id), manifest);
}

export function addAsset(project: Project, asset: Omit<AssetRecord, "id" | "createdAt">): AssetRecord {
  const record: AssetRecord = { ...asset, id: crypto.randomUUID().slice(0, 8), createdAt: nowIso() };
  project.assets.push(record);
  return record;
}

export async function projectExists(id: string) {
  return exists(projectFile(id));
}

export async function readSession<T>(id: string): Promise<T[]> {
  return (await readJsonIfExists<T[]>(sessionFile(id))) ?? [];
}

export async function writeSession(id: string, messages: unknown[]) {
  await writeJson(sessionFile(id), messages);
}

