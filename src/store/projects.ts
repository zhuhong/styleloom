import { join } from "node:path";
import { dataDir } from "../config";
import type { AssetRecord, LearningState, Project, ProjectSummary, SliceManifest } from "../types";
import { normalizeStyleBible } from "../learn/bible";
import { exists, ensureDir, listDirs, nowIso, readJsonIfExists, removeDir, slugify, writeJson } from "../util/fs";

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
    // 先按最后更新时间逆序，相同时再按创建时间逆序。
    .sort((left, right) => {
      const byUpdated = right.updatedAt.localeCompare(left.updatedAt);
      if (byUpdated) return byUpdated;
      return right.createdAt.localeCompare(left.createdAt);
    })
    .map(project => ({
      id: project.id,
      title: project.title,
      stage: project.stage,
      createdAt: project.createdAt,
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
  if (project.styleBible) project.styleBible = normalizeStyleBible(project.styleBible);
  return project;
}

/**
 * 按项目串行化的写锁。
 * 后台渲染任务与对话轮次可能同时改 project.json，不串行会互相覆盖。
 */
const projectLocks = new Map<string, Promise<unknown>>();

export function withProjectLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = projectLocks.get(id) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  // 无论成败都要释放锁，否则一次失败会永久阻塞该项目。
  projectLocks.set(id, next.catch(() => undefined));
  return next;
}

export async function saveProject(project: Project) {
  if (project.styleBible) project.styleBible = normalizeStyleBible(project.styleBible);
  project.updatedAt = nowIso();
  await withProjectLock(project.id, () => writeJson(projectFile(project.id), project));
  return project;
}

/**
 * 读最新盘上状态 → 交给 mutator 修改 → 写回。
 * 后台任务用它，避免拿着旧快照覆盖对话轮次刚写的内容。
 */
export async function mutateProject<T>(id: string, mutator: (project: Project) => T | Promise<T>): Promise<T> {
  return withProjectLock(id, async () => {
    const project = await getProject(id);
    const result = await mutator(project);
    if (project.styleBible) project.styleBible = normalizeStyleBible(project.styleBible);
    project.updatedAt = nowIso();
    await writeJson(projectFile(id), project);
    return result;
  });
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

/** 只改标题，不改目录 id（引用/会话路径保持稳定）。 */
export async function renameProject(id: string, title: string): Promise<Project> {
  const cleanTitle = title.trim();
  if (!cleanTitle) throw new Error("项目名称不能为空");
  return mutateProject(id, project => {
    project.title = cleanTitle;
    return project;
  });
}

/**
 * 删除整个项目目录。
 * 技能/风格包在 data/skills、data/library，不随项目删；调用方需先清内存里的渲染任务。
 */
export async function deleteProject(id: string): Promise<void> {
  await getProject(id);
  await withProjectLock(id, async () => {
    await removeDir(projectDir(id));
  });
  projectLocks.delete(id);
}

export async function readSession<T>(id: string): Promise<T[]> {
  return (await readJsonIfExists<T[]>(sessionFile(id))) ?? [];
}

export async function writeSession(id: string, messages: unknown[]) {
  await writeJson(sessionFile(id), messages);
}

