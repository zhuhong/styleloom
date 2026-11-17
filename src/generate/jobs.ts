import { loadSettings } from "../config";
import type { AgentEvent } from "../types";
import { getProject, listProjects, mutateProject } from "../store/projects";
import type { Project } from "../types";
import { generateShot, resumeShot } from "./shot";

export type RenderJobStatus = "running" | "done" | "failed" | "pending";

export type RenderJob = {
  id: string;
  projectId: string;
  shotId: string;
  status: RenderJobStatus;
  percent: number;
  label: string;
  startedAt: string;
  updatedAt: string;
  videoId?: string;
  video?: string;
  error?: string;
};

/** 内存注册表：服务重启后丢失，靠 project.json 里的 shot 状态恢复（见 reconcileStaleJobs）。 */
const jobs = new Map<string, RenderJob>();
/** 每个项目一个订阅者集合，用于把进度推给右侧面板。 */
const subscribers = new Map<string, Set<(job: RenderJob) => void>>();
/**
 * 正在跑的 generateShot 持有的镜头快照读取器。
 * 对话旧快照可能把盘上 videoId 抹掉，重启前可用 flushLiveVideoIds 把内存里的任务 ID 写回盘。
 */
const liveShotReaders = new Map<string, () => string | undefined>();

function liveKey(projectId: string, shotId: string) {
  return `${projectId}::${shotId}`;
}

function now() {
  return new Date().toISOString();
}

function broadcast(job: RenderJob) {
  for (const send of subscribers.get(job.projectId) ?? []) {
    try {
      send(job);
    } catch {
      // 订阅者已断开，下次写会自然清理
    }
  }
}

export function subscribeJobs(projectId: string, send: (job: RenderJob) => void) {
  const set = subscribers.get(projectId) ?? new Set();
  set.add(send);
  subscribers.set(projectId, set);
  return () => {
    set.delete(send);
    if (!set.size) subscribers.delete(projectId);
  };
}

export function listJobs(projectId: string): RenderJob[] {
  return [...jobs.values()]
    .filter(job => job.projectId === projectId)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

/** 项目删除时清掉内存任务与订阅，避免幽灵进度。 */
export function clearJobsForProject(projectId: string) {
  for (const [id, job] of jobs) {
    if (job.projectId === projectId) jobs.delete(id);
  }
  subscribers.delete(projectId);
  for (const key of liveShotReaders.keys()) {
    if (key.startsWith(`${projectId}::`)) liveShotReaders.delete(key);
  }
}

/**
 * 把仍在内存轮询中的 videoId 写回 project.json。
 * 用于修复「面板显示 queued、盘上却没有 videoId」的竞态，并在重启前保全已计费任务。
 */
export async function flushLiveVideoIds(projectId?: string) {
  const flushed: { projectId: string; shotId: string; videoId: string }[] = [];
  for (const [key, readVideoId] of liveShotReaders) {
    const [jobProjectId, shotId] = key.split("::");
    if (projectId && jobProjectId !== projectId) continue;
    const videoId = readVideoId()?.trim();
    if (!videoId) continue;
    await mutateProject(jobProjectId, project => {
      const shot = project.plan.find(item => item.id === shotId);
      if (!shot) return;
      if (!shot.videoId) {
        shot.videoId = videoId;
        shot.videoCreatedAt ??= now();
      }
      if (shot.status === "planned" || shot.status === "promptReady") {
        shot.status = "generating";
        shot.error = undefined;
      }
      const job = activeJobForShot(jobProjectId, shotId);
      if (job) patch(job, { videoId: shot.videoId });
      flushed.push({ projectId: jobProjectId, shotId, videoId: shot.videoId! });
    });
  }
  return flushed;
}

export function getJob(jobId: string): RenderJob | undefined {
  return jobs.get(jobId);
}

export function activeJobForShot(projectId: string, shotId: string): RenderJob | undefined {
  return listJobs(projectId).find(job => job.shotId === shotId && job.status === "running");
}

function patch(job: RenderJob, changes: Partial<RenderJob>) {
  Object.assign(job, changes, { updatedAt: now() });
  broadcast(job);
  return job;
}

export type StartRenderJobOptions = {
  projectId: string;
  shotId: string;
  promptOverride?: string;
  durationSeconds?: number;
  experimentalDuration?: boolean;
  skillIds?: string[];
};

/**
 * 启动一个后台渲染任务并立即返回。
 *
 * 与船旧的同步实现相比，这里不再把 HTTP 请求绑在渲染上：
 * - 对话轮次提交后立刻结束，用户能继续聊；
 * - 进度通过 SSE 推到右侧面板，不占对话气泡；
 * - 服务端自己持有轮询，浏览器关掉也不会中断（这点以前会 abort 掉任务）。
 *
 * ACT: 写盘用 mutateProject（读最新 → 改 → 写），避免覆盖对话轮次刚保存的其它字段；
 * 反过来若对话轮次在任务完成后再整份保存旧快照，仍可能回退渲染结果，故约定
 * 提交任务后 Agent 不再改该镜头的字段。
 */
function register(projectId: string, shotId: string, label: string): RenderJob {
  const job: RenderJob = {
    id: `job_${crypto.randomUUID().slice(0, 8)}`,
    projectId,
    shotId,
    status: "running",
    percent: 0,
    label,
    startedAt: now(),
    updatedAt: now(),
  };
  jobs.set(job.id, job);
  broadcast(job);
  return job;
}

export function startRenderJob(options: StartRenderJobOptions): RenderJob {
  const existing = activeJobForShot(options.projectId, options.shotId);
  if (existing) return existing;
  const job = register(options.projectId, options.shotId, "准备中");
  void run(job, options);
  return job;
}

/** 从面板按钮接回 pending 任务：不新建平台任务，因此不重复计费。 */
export function startResumeJob(projectId: string, shotId: string): RenderJob {
  const existing = activeJobForShot(projectId, shotId);
  if (existing) return existing;
  const job = register(projectId, shotId, "接回已提交任务");
  void runResume(job);
  return job;
}

/**
 * 把渲染快照里「该镜头 + 新素材 + 阶段」这部分合并进盘上最新状态。
 * 只覆盖这些字段，其余（分镜表、风格圣经、其它镜头）一律以盘上为准，
 * 这样后台渲染和对话轮次并发写不会互相抹掉。
 */
async function mergeShotState(projectId: string, shotId: string, snapshot: Project) {
  const shot = snapshot.plan.find(item => item.id === shotId);
  if (!shot) return;
  await mutateProject(projectId, latest => {
    const target = latest.plan.find(item => item.id === shotId);
    if (target) {
      target.status = shot.status;
      target.video = shot.video;
      target.videoId = shot.videoId;
      target.videoCreatedAt = shot.videoCreatedAt;
      target.error = shot.error;
      target.prompt = shot.prompt;
      target.promptMode = shot.promptMode;
      target.updatedAt = shot.updatedAt;
    }
    for (const asset of snapshot.assets) {
      if (!latest.assets.some(item => item.path === asset.path)) latest.assets.push(asset);
    }
    if (shot.status === "done" && (latest.stage === "plan" || latest.stage === "study")) latest.stage = "generate";
  });
}

async function run(job: RenderJob, options: StartRenderJobOptions) {
  const abort = new AbortController();
  const key = liveKey(options.projectId, options.shotId);
  try {
    const settings = await loadSettings();
    const project = await getProject(options.projectId);
    liveShotReaders.set(key, () => project.plan.find(item => item.id === options.shotId)?.videoId);
    const result = await generateShot({
      project,
      settings,
      shotId: options.shotId,
      promptOverride: options.promptOverride,
      durationSeconds: options.durationSeconds,
      experimentalDuration: options.experimentalDuration,
      skillIds: options.skillIds,
      signal: abort.signal,
      onProgress: (percent, label) => {
        const shot = project.plan.find(item => item.id === options.shotId);
        patch(job, {
          percent,
          label,
          // 提交成功后立刻挂到 job 上，避免只在盘上有 videoId、面板/Agent 两边对不上
          ...(shot?.videoId ? { videoId: shot.videoId } : {}),
        });
      },
      persist: async snapshot => {
        await mergeShotState(job.projectId, options.shotId, snapshot);
        const shot = snapshot.plan.find(item => item.id === options.shotId);
        if (shot?.videoId) patch(job, { videoId: shot.videoId });
      },
    });
    patch(job, { status: "done", percent: 100, label: `${options.shotId} 生成完成`, video: result.video, videoId: result.videoId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 与 generateShot 的判定保持一致：已提交但本地放弃等待 → pending，可 resume。
    const latest = await getProject(job.projectId).catch(() => undefined);
    const shot = latest?.plan.find(item => item.id === options.shotId);
    const memoryVideoId = liveShotReaders.get(key)?.();
    const videoId = shot?.videoId || memoryVideoId;
    const submitted = Boolean(videoId);
    const abandoned = submitted && /仍未完成|超时|取消|aborted/i.test(message);
    if (videoId && !shot?.videoId) {
      await mutateProject(job.projectId, project => {
        const target = project.plan.find(item => item.id === options.shotId);
        if (!target) return;
        target.videoId = videoId;
        target.videoCreatedAt ??= now();
        target.status = abandoned ? "pending" : target.status;
      }).catch(() => undefined);
    }
    patch(job, {
      status: abandoned ? "pending" : "failed",
      label: abandoned ? "已提交，等待恢复" : "生成失败",
      error: message,
      videoId,
    });
  } finally {
    liveShotReaders.delete(key);
  }
}

async function runResume(job: RenderJob) {
  const abort = new AbortController();
  try {
    const settings = await loadSettings();
    const project = await getProject(job.projectId);
    const result = await resumeShot({
      project,
      settings,
      shotId: job.shotId,
      signal: abort.signal,
      onProgress: (percent, label) => patch(job, { percent, label }),
      persist: snapshot => mergeShotState(job.projectId, job.shotId, snapshot),
    });
    patch(job, {
      status: "done",
      percent: 100,
      label: `${job.shotId} 恢复完成`,
      video: result.video,
      videoId: result.videoId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const latest = await getProject(job.projectId).catch(() => undefined);
    const shot = latest?.plan.find(item => item.id === job.shotId);
    patch(job, {
      status: "failed",
      label: "恢复失败",
      error: message,
      videoId: shot?.videoId,
    });
  }
}

/**
 * 服务重启后，内存里的任务全丢，但 project.json 里可能留着渲染中的痕迹。
 * 判定依据是「有 videoId 且未 done」而不是只看 status：
 * generateShot 会先把 status 写成 generating 落盘，拿到平台任务 ID 后再写一次
 * videoId，这两次写盘之间存在窗口，重启时可能落在 status=promptReady 但
 * videoId 已存在的状态（真实踩到过）。只要拿到了 videoId 就说明已经计费，
 * 一律标 pending 让用户走 resume，不能当成没生成。
 */
export async function reconcileStaleJobs() {
  const repaired: string[] = [];
  for (const summary of await listProjects()) {
    await mutateProject(summary.id, project => {
      let changed = false;
      for (const shot of project.plan) {
        if (shot.status === "done" || shot.status === "failed" || shot.status === "pending") continue;
        const unfinished = shot.status === "generating";
        if (!unfinished && !shot.videoId) continue;
        if (shot.videoId) {
          shot.status = "pending";
          shot.error = `服务重启时该镜头仍在渲染（video_id=${shot.videoId}），任务可能已在平台完成，可用 resume_shot 接回。`;
        } else {
          shot.status = "failed";
          shot.error = "服务重启时该镜头刚开始渲染，尚未拿到平台任务 ID，需要重新生成。";
        }
        shot.updatedAt = new Date().toISOString();
        changed = true;
        repaired.push(`${summary.id}/${shot.id}`);
      }
      return changed;
    });
    // 把盘上的 pending 镜头回填成一条 job，否则重启后「渲染」面板是空的，
    // 用户看不到可恢复的任务，只能去分镜页找。
    const project = await getProject(summary.id);
    for (const shot of project.plan) {
      if (shot.status !== "pending" || !shot.videoId) continue;
      if (activeJobForShot(summary.id, shot.id)) continue;
      const job: RenderJob = {
        id: `job_${crypto.randomUUID().slice(0, 8)}`,
        projectId: summary.id,
        shotId: shot.id,
        status: "pending",
        percent: 0,
        label: "已提交，等待恢复",
        startedAt: shot.videoCreatedAt || shot.updatedAt || now(),
        updatedAt: shot.updatedAt || now(),
        videoId: shot.videoId,
        error: shot.error,
      };
      jobs.set(job.id, job);
    }
  }
  return repaired;
}

export type { AgentEvent };
