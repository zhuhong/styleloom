import { readFile } from "node:fs/promises";
import { loadSettings, type Settings } from "../../config";
import { MAX_SHOT_SECONDS, MIN_SHOT_SECONDS } from "../../util/duration";
import { mimeFromPath } from "../llm";
import type { VideoJob, VideoResult } from "./types";

type LocalMode = { model: string; task: string; refs: string[]; notes: string[] };

function gatewayBase(settings: Settings) {
  return settings.video.local.baseUrl.trim().replace(/\/+$/, "") || "http://127.0.0.1:8000";
}

function gatewayHeaders(settings: Settings, extra: Record<string, string> = {}) {
  const token = settings.video.local.token.trim();
  return { ...extra, ...(token ? { "X-Toonflow-Gateway-Token": token } : {}) };
}

function withTimeout(signal: AbortSignal | undefined, ms: number) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function gatewayJson(url: string, init: RequestInit, signal: AbortSignal) {
  const response = await fetch(url, { ...init, signal });
  const text = await response.text();
  if (!response.ok) throw new Error(`本地网关请求失败（HTTP ${response.status}）：${text.slice(0, 500)}`);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`本地网关返回非 JSON：${text.slice(0, 300)}`);
  }
}

function wait(signal: AbortSignal, ms: number) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("已取消"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * 把通用 VideoJob 映射到网关支持的三种 H3 模式。
 * ACT: 网关的 h3Fl2va 只吃首帧（没有尾帧位），h3Ref2va 只吃一张参考图；
 * 尾帧、参考视频目前没有对应 CLI 能力，直接报错而不是静默降级。
 */
function pickLocalMode(request: VideoJob): LocalMode {
  const notes: string[] = [];
  if ((request.referenceVideos?.length ?? 0) > 0) {
    throw new Error("本地网关不支持参考视频，请把 video.provider 改为 icompify，或移除参考视频");
  }
  if (request.lastFrame) {
    throw new Error("本地网关不支持尾帧（FL2VA/L2VA），请改用 icompify 或去掉尾帧");
  }
  if (request.firstFrame) return { model: "h3Fl2va", task: "i2va", refs: [request.firstFrame], notes };
  const images = request.referenceImages ?? [];
  if (images.length) {
    if (images.length > 1) notes.push(`本地 H3 ref2va 仅使用第 1 张参考图，已忽略其余 ${images.length - 1} 张`);
    return { model: "h3Ref2va", task: "ref2va", refs: [images[0]], notes };
  }
  return { model: "h3T2v", task: "t2va", refs: [], notes };
}

/** 短边 + 画幅比例 → 宽高；对齐 32，和 Qwen/H3 的常见训练网格一致。 */
function localSize(shortEdge: number, ratio: string) {
  const snap = (value: number) => Math.max(256, Math.floor(value / 32) * 32);
  const [width, height] = (ratio || "16:9").split(":").map(Number);
  if (!width || !height) return { width: 832, height: 480 };
  const edge = Math.min(1024, Math.max(256, Math.round(shortEdge) || 480));
  return width >= height
    ? { width: snap((edge * width) / height), height: snap(edge) }
    : { width: snap(edge), height: snap((edge * height) / width) };
}

async function toGatewayRef(path: string) {
  const bytes = await readFile(path);
  if (!bytes.byteLength) throw new Error(`参考素材为空：${path}`);
  return { data: Buffer.from(bytes).toString("base64"), mimeType: mimeFromPath(path) };
}

async function cancelGatewayJob(base: string, settings: Settings, jobId: string) {
  // ACT: 客户端 abort 只会断掉自己的连接，必须显式 DELETE，否则 GPU 会继续跑到 lease 超时。
  await fetch(`${base}/v1/jobs/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
    headers: gatewayHeaders(settings),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined);
}

/**
 * 本地视频生成：styleloom → 本地网关 → 推理脚本。
 * 网关是单 worker 串行队列，H3 约 30G 显存，和 Qwen 出图不能并发。
 */
export async function generateLocalVideoJob(request: VideoJob, settings: Settings): Promise<VideoResult> {
  const duration = Math.round(request.durationSeconds);
  if (!Number.isInteger(duration) || duration < MIN_SHOT_SECONDS || duration > MAX_SHOT_SECONDS) {
    throw new Error(`H3 视频时长必须是 ${MIN_SHOT_SECONDS} 到 ${MAX_SHOT_SECONDS} 秒之间的整数`);
  }
  const { model, task, refs, notes } = pickLocalMode(request);
  const ratio = request.aspectRatio ?? settings.video.aspectRatio ?? "16:9";
  const { width, height } = localSize(settings.video.local.shortEdge, ratio);
  const base = gatewayBase(settings);
  const signal = request.signal ?? new AbortController().signal;
  const refPayload = await Promise.all(refs.map(toGatewayRef));

  request.onProgress?.("提交本地任务", 0);
  const created = await gatewayJson(`${base}/v1/jobs`, {
    method: "POST",
    headers: gatewayHeaders(settings, { "Content-Type": "application/json", Accept: "application/json" }),
    body: JSON.stringify({
      model,
      prompt: request.prompt,
      // 不传 steps：网关按模型给默认值（ref2va 8 步，其余 20 步）。
      params: { width, height, duration },
      refs: refPayload,
    }),
  }, withTimeout(signal, 120_000));
  const jobId = typeof created.id === "string" ? created.id.trim() : "";
  if (!jobId) throw new Error("本地网关未返回任务 ID");
  request.onVideoId?.(jobId);

  const started = Date.now();
  const interval = Math.max(1_000, Math.min(settings.video.pollIntervalMs, 5_000));
  try {
    while (true) {
      await wait(signal, interval);
      const elapsed = Math.round((Date.now() - started) / 1000);
      let info: Record<string, unknown>;
      try {
        info = await gatewayJson(`${base}/v1/jobs/${encodeURIComponent(jobId)}`, {
          method: "GET",
          headers: gatewayHeaders(settings, { Accept: "application/json" }),
        }, withTimeout(signal, 30_000));
      } catch (error) {
        if (signal.aborted) throw error;
        request.onProgress?.("查询失败，重试", elapsed);
        continue;
      }
      const status = String(info.status ?? "").toLowerCase();
      const percent = typeof info.progress === "number" ? info.progress : undefined;
      const ahead = typeof info.queuedAhead === "number" ? info.queuedAhead : 0;
      const label = status !== "queued" ? "生成中" : ahead > 0 ? `排队中（前面 ${ahead} 个）` : "排队中";
      request.onProgress?.(label, elapsed, percent);
      if (status === "done") {
        request.onProgress?.("下载中", elapsed, 100);
        const response = await fetch(`${base}/v1/jobs/${encodeURIComponent(jobId)}/file`, {
          headers: gatewayHeaders(settings),
          signal: withTimeout(signal, 600_000),
        });
        if (!response.ok) throw new Error(`本地网关视频下载失败：HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.byteLength) throw new Error("本地网关返回的视频内容为空");
        return { videoId: jobId, bytes, mimeType: "video/mp4", task, model, platform: { gateway: base, job: info }, notes };
      }
      if (status === "failed") {
        const detail = String(info.error ?? "").trim() || (Array.isArray(info.log) ? info.log.slice(-5).join("\n") : "");
        throw new Error(`本地网关任务失败：${detail || "无错误详情"}`);
      }
      if (status === "canceled") throw new Error("本地网关任务已取消");
      if (Date.now() - started > settings.video.maxWaitMs) {
        throw new Error(`本地网关任务超过 ${Math.round(settings.video.maxWaitMs / 60000)} 分钟仍未完成，job=${jobId}`);
      }
    }
  } catch (error) {
    await cancelGatewayJob(base, settings, jobId);
    throw error;
  }
}

/** 本地视频网关自检：只打 /v1/health，不占显存。 */
export async function checkLocalVideo(signal?: AbortSignal) {
  const settings = await loadSettings();
  const base = gatewayBase(settings);
  try {
    const info = await gatewayJson(`${base}/v1/health`, {
      method: "GET",
      headers: gatewayHeaders(settings, { Accept: "application/json" }),
    }, withTimeout(signal, 5_000));
    const models = Array.isArray(info.models) ? info.models.join("、") : "未知";
    const running = Array.isArray(info.running) ? info.running.length : 0;
    const queued = Array.isArray(info.queued) ? info.queued.length : 0;
    return { ok: true, detail: `网关可达（${base}）；模型：${models}；运行中 ${running}，排队 ${queued}` };
  } catch (error) {
    return { ok: false, detail: `网关不可用（${base}）：${(error as Error).message.slice(0, 200)}；请先启动 diffsynthGateway.py` };
  }
}
