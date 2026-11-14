import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists } from "./fs";

export type SshOptions = { signal?: AbortSignal; timeoutMs?: number };

/** 远端 shell 单引号转义：把 ' 变成 '\''，其余原样。 */
export function shellQuote(value: string) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

async function run(command: string[], options: SshOptions = {}) {
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("已取消");
  const timeout = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
  const signal = options.signal && timeout ? AbortSignal.any([options.signal, timeout]) : (options.signal ?? timeout);
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const abort = () => proc.kill();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("已取消");
    if (timeout?.aborted) throw new Error(`远程命令超时（>${Math.round((options.timeoutMs ?? 0) / 1000)}s）`);
    return { stdout, stderr, code };
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

/** 在远端执行一条命令，返回 stdout；失败时抛出带 stderr 尾部的错误。 */
export async function sshRun(sshBin: string, host: string, remoteCommand: string, options: SshOptions = {}) {
  const result = await run([sshBin, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, remoteCommand], options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(-8).join("\n").slice(-1200);
    throw new Error(`SSH 执行失败（${host}，退出码 ${result.code}）：${detail || "无错误输出"}`);
  }
  return result.stdout;
}

/** 探测远端是否可达（免密登录），用于自动选择后端。 */
export async function sshReachable(sshBin: string, host: string, signal?: AbortSignal) {
  if (!host) return false;
  try {
    const result = await run([sshBin, "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, "true"], { signal, timeoutMs: 20_000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

async function scp(scpBin: string, args: string[], options: SshOptions = {}) {
  const result = await run([scpBin, "-q", "-o", "BatchMode=yes", ...args], options);
  if (result.code !== 0) {
    throw new Error(`SCP 传输失败（退出码 ${result.code}）：${(result.stderr || result.stdout).trim().slice(-600)}`);
  }
}

export async function scpToRemote(scpBin: string, host: string, localPath: string, remotePath: string, options: SshOptions = {}) {
  await scp(scpBin, [localPath, `${host}:${shellQuote(remotePath)}`], options);
}

export async function scpFromRemote(scpBin: string, host: string, remotePath: string, localPath: string, options: SshOptions = {}) {
  await scp(scpBin, [`${host}:${shellQuote(remotePath)}`, localPath], options);
}

/**
 * 在远端建一个任务专属临时目录，跑完后整目录删掉。
 * 远端目录里只放本次的输入图和输出图，避免多次任务互相覆盖。
 */
export async function withRemoteWorkdir<T>(
  options: { sshBin: string; host: string; workdir: string; tag: string; signal?: AbortSignal; timeoutMs?: number },
  body: (remoteDir: string) => Promise<T>,
): Promise<T> {
  const remoteDir = `${options.workdir.replace(/\/+$/, "")}/remote_outputs/videocopy-${options.tag}`;
  const runOptions: SshOptions = { signal: options.signal, timeoutMs: options.timeoutMs };
  await sshRun(options.sshBin, options.host, `mkdir -p ${shellQuote(remoteDir)}`, runOptions);
  try {
    return await body(remoteDir);
  } finally {
    await sshRun(options.sshBin, options.host, `rm -rf ${shellQuote(remoteDir)}`, runOptions).catch(() => undefined);
  }
}

/** 把远端文件拉到本地临时文件，调用方负责搬运与清理。 */
export async function fetchRemoteFile(options: {
  scpBin: string;
  host: string;
  remotePath: string;
  fileName: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}) {
  const dir = await mkdtemp(join(tmpdir(), "videocopy-remote-"));
  const local = join(dir, options.fileName);
  try {
    await scpFromRemote(options.scpBin, options.host, options.remotePath, local, { signal: options.signal, timeoutMs: options.timeoutMs });
    if (!(await exists(local))) throw new Error(`远端文件未拉取成功：${options.remotePath}`);
    const size = (await stat(local)).size;
    if (size < 1024) throw new Error(`远端产物过小（${size} 字节），可能生成失败`);
    return { dir, path: local, size };
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
