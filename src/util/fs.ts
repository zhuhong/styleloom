import { mkdir, readFile, writeFile, rename, access, copyFile, stat, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true });
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  if (!(await exists(path))) return undefined;
  return readJson<T>(path);
}

/** 先写临时文件再改名，避免中途崩溃留下半截 JSON。 */
export async function writeJson(path: string, value: unknown) {
  await ensureDir(dirname(path));
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export async function writeText(path: string, value: string) {
  await ensureDir(dirname(path));
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, value, "utf8");
  await rename(temporary, path);
}

export async function copyInto(from: string, to: string) {
  await ensureDir(dirname(to));
  await copyFile(from, to);
  return to;
}

export async function fileSize(path: string) {
  return (await stat(path)).size;
}

export async function listDirs(path: string) {
  if (!(await exists(path))) return [];
  return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
}

/** 项目内相对路径 -> 绝对路径，越界直接抛错。 */
export function safeJoin(root: string, path: string) {
  if (!path || isAbsolute(path) || path.includes("\0")) throw new Error(`非法路径：${path}`);
  const normalized = normalize(path).replaceAll("\\", "/");
  if (normalized === ".." || normalized.startsWith("../")) throw new Error(`路径越界：${path}`);
  const absolute = resolve(root, normalized);
  const rootResolved = resolve(root);
  if (absolute !== rootResolved && !absolute.startsWith(rootResolved + sep)) throw new Error(`路径越界：${path}`);
  return absolute;
}

/** 绝对路径 -> 项目内相对路径（POSIX 风格）。 */
export function toProjectPath(root: string, absolute: string) {
  return relative(root, absolute).split(sep).join("/");
}

export function slugify(value: string, fallback = "project") {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || fallback;
}

export function nowIso() {
  return new Date().toISOString();
}

export function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export async function removeDir(path: string) {
  await rm(path, { recursive: true, force: true });
}

export async function listFiles(path: string, extension?: string): Promise<string[]> {
  if (!(await exists(path))) return [];
  const entries = await readdir(path, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && (!extension || entry.name.endsWith(extension)))
    .map(entry => join(path, entry.name));
}
