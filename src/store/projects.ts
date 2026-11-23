import { join } from "node:path";
import { dataDir } from "../config";
import type { AssetRecord, LearningState, MeasureManifest, Project, ProjectSummary, SliceManifest } from "../types";
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

export function measureFile(id: string) {
  return join(projectDir(id), "learning", "measure.json");
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
 * 对话轮次写盘：把内存里的项目变更合并进盘上最新状态。
 * 绝不能整份覆盖——后台 generate_shot 可能已写入 videoId / generating / done，
 * 用对话开始时的旧快照 saveProject 会把已计费任务抹掉，Agent 就会误报「无平台任务」并二次提交。
 */
export async function saveProjectMergingRender(project: Project) {
  return withProjectLock(project.id, async () => {
    const latest = await getProject(project.id);
    const diskById = new Map(latest.plan.map(shot => [shot.id, shot]));
    latest.title = project.title;
    latest.stage = project.stage;
    latest.brief = project.brief;
    latest.learning = project.learning;
    latest.styleBible = project.styleBible;
    latest.libraryPackId = project.libraryPackId;
    latest.plan = project.plan.map(memory => {
      const disk = diskById.get(memory.id);
      if (!disk) return memory;
      const next = { ...memory };
      // 盘上已有平台任务 ID，内存没有 → 保留盘上的（含创建时间）
      if (disk.videoId && !next.videoId) {
        next.videoId = disk.videoId;
        next.videoCreatedAt = next.videoCreatedAt ?? disk.videoCreatedAt;
      }
      if (disk.video && !next.video) next.video = disk.video;
      const memoryIdle = next.status === "planned" || next.status === "promptReady";
      const diskRender = disk.status === "generating" || disk.status === "pending" || disk.status === "done"
        || (Boolean(disk.videoId) && disk.status !== "failed");
      // 内存还停在「可提交」而盘上已进入渲染生命周期 → 跟盘上走，避免把 generating 打回 promptReady
      if (memoryIdle && diskRender) {
        next.status = disk.status === "promptReady" && disk.videoId ? "generating" : disk.status;
        if (disk.error !== undefined) next.error = disk.error;
        if (disk.updatedAt) next.updatedAt = disk.updatedAt;
      }
      if (disk.status === "done" && next.status !== "done") {
        next.status = "done";
        next.video = disk.video ?? next.video;
        next.videoId = disk.videoId ?? next.videoId;
        next.error = undefined;
      }
      if (disk.status === "pending" && memoryIdle) {
        next.status = "pending";
        next.error = disk.error;
      }
      return next;
    });
    const assetPaths = new Set(latest.assets.map(asset => asset.path));
    for (const asset of project.assets) {
      if (!assetPaths.has(asset.path)) {
        latest.assets.push(asset);
        assetPaths.add(asset.path);
      }
    }
    if (latest.styleBible) latest.styleBible = normalizeStyleBible(latest.styleBible);
    latest.updatedAt = nowIso();
    await writeJson(projectFile(project.id), latest);
    // 回写内存，让同轮后续工具看到合并后的 videoId / status
    project.title = latest.title;
    project.stage = latest.stage;
    project.brief = latest.brief;
    project.learning = latest.learning;
    project.styleBible = latest.styleBible;
    project.libraryPackId = latest.libraryPackId;
    project.plan = latest.plan;
    project.assets = latest.assets;
    project.updatedAt = latest.updatedAt;
    return latest;
  });
}

/**
 * 读最新盘上状态 → 交给 mutator 修改 → 写回。
 * 后台任务用它，避免拿着旧快照覆盖对话轮次刚写的内容。
 *
 * mutator 返回 `false` 时视为「无变更」：不落盘、不刷 updatedAt。
 * 否则每次服务启动的 reconcile 都会把所有项目的 updatedAt 刷成当前时间，
 * 侧栏按 updatedAt 排序就彻底失效（真实踩到：6 个项目挤进 4 毫秒）。
 */
export async function mutateProject<T>(id: string, mutator: (project: Project) => T | Promise<T>): Promise<T> {
  return withProjectLock(id, async () => {
    const project = await getProject(id);
    const result = await mutator(project);
    if (result === false) return result;
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

export async function getMeasure(project: Project): Promise<MeasureManifest | undefined> {
  return readJsonIfExists<MeasureManifest>(measureFile(project.id));
}

export async function saveMeasure(project: Project, measure: MeasureManifest) {
  await writeJson(measureFile(project.id), measure);
}

export function addAsset(project: Project, asset: Omit<AssetRecord, "id" | "createdAt">): AssetRecord {
  // 同路径重复登记会让右侧素材栏出现重复卡片；只在路径变化时追加，否则更新标签/元信息。
  // 迁移遗留的重复登记（同路径多条）：保留最后一条，避免素材栏重复。
  project.assets = project.assets.filter((item, index, all) => all.findIndex(other => other.path === item.path) === index);
  const existing = project.assets.find(item => item.path === asset.path);
  if (existing) {
    if (asset.label) existing.label = asset.label;
    if (asset.kind) existing.kind = asset.kind;
    if (asset.meta) existing.meta = { ...existing.meta, ...asset.meta };
    return existing;
  }
  const record: AssetRecord = { ...asset, id: crypto.randomUUID().slice(0, 8), createdAt: nowIso() };
  project.assets.push(record);
  return record;
}

export async function projectExists(id: string) {
  return exists(projectFile(id));
}

/**
 * 启动时的轻量修复：修正 assets[] 的重复登记与磁盘缺失项。
 * 只做保守处理——同路径去重（保留最后一条）、已不存在的文件条目标记而非删除，避免破坏历史引用。
 */
export async function reconcileProjectAssets(id: string): Promise<{ deduped: number; missing: string[] }> {
  const project = await readJsonIfExists<Project>(projectFile(id));
  if (!project?.assets?.length) return { deduped: 0, missing: [] };

  const seen = new Map<string, AssetRecord>();
  for (const asset of project.assets) seen.set(asset.path, asset);
  const deduped = project.assets.length - seen.size;

  const missing: string[] = [];
  for (const asset of seen.values()) {
    if (!(await exists(join(projectDir(id), asset.path)))) missing.push(asset.path);
  }

  if (deduped > 0) {
    // 保持原有出现顺序，只是去掉同路径的旧记录。
    const order = [...new Set(project.assets.map(asset => asset.path))];
    project.assets = order.map(path => seen.get(path)!).filter(Boolean);
    await writeJson(projectFile(id), project);
  }
  return { deduped, missing };
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

