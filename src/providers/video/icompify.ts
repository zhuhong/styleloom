import { readFile } from "node:fs/promises";
import { loadSettings } from "../../config";
import { MAX_SHOT_SECONDS, MIN_SHOT_SECONDS } from "../../util/duration";
import { mimeFromPath } from "../llm";
import type { VideoJob, VideoResult } from "./types";

const validRatios = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "auto"];
const maxReferenceImages = 4;
const maxReferenceVideos = 3;
const maxReferenceBytes = 140 * 1024 * 1024;

export type { VideoJob, VideoResult } from "./types";

async function toDataUri(path: string) {
  const bytes = await readFile(path);
  if (!bytes.byteLength) throw new Error(`参考素材为空：${path}`);
  if (bytes.byteLength > maxReferenceBytes) throw new Error(`参考素材超过 140MB：${path}`);
  return `data:${mimeFromPath(path)};base64,${Buffer.from(bytes).toString("base64")}`;
}

export function isOfficialPrompt(prompt: string) {
  const text = prompt.toLowerCase();
  return text.includes("integrated_multimodal_description") || text.includes("detailed_description");
}

function officialMode(request: VideoJob) {
  if (request.referenceVideos?.length) return "ref2va" as const;
  if (request.firstFrame && request.lastFrame) return "fl2va" as const;
  if (request.firstFrame) return "i2va" as const;
  if (request.lastFrame) return "l2va" as const;
  return "t2va" as const;
}

async function requestJson(url: string, apiKey: string, init: RequestInit, signal: AbortSignal) {
  const response = await fetch(url, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${apiKey}` },
    signal,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`icompify 请求失败（HTTP ${response.status}）：${text.slice(0, 500)}`);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`icompify 返回非 JSON：${text.slice(0, 300)}`);
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

/** icompify / MiniMax H3：创建任务 → 轮询 → 下载。 */
export async function generateVideoJob(request: VideoJob): Promise<VideoResult> {
  const settings = await loadSettings();
  const apiKey = settings.video.apiKey.trim();
  if (!apiKey) throw new Error("尚未配置 icompify API Key");
  const baseUrl = settings.video.baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  const duration = Math.round(request.durationSeconds);
  // H3 常规下限 4s；2/3s 属于实验档位，由 generate/shot.ts 决定直发还是 4s+裁剪。
  if (!Number.isInteger(duration) || duration < MIN_SHOT_SECONDS || duration > MAX_SHOT_SECONDS) {
    throw new Error(`H3 视频时长必须是 ${MIN_SHOT_SECONDS} 到 ${MAX_SHOT_SECONDS} 秒之间的整数`);
  }
  const ratio = request.aspectRatio ?? settings.video.aspectRatio ?? "16:9";
  if (!validRatios.includes(ratio)) throw new Error(`不支持的画幅：${ratio}，可选 ${validRatios.join("、")}`);

  const referenceImages = request.referenceImages ?? [];
  const referenceVideos = request.referenceVideos ?? [];
  if (referenceImages.length > maxReferenceImages) throw new Error(`参考图最多 ${maxReferenceImages} 张`);
  if (referenceVideos.length > maxReferenceVideos) throw new Error(`参考视频最多 ${maxReferenceVideos} 段`);

  const useReference = referenceVideos.length > 0 || (referenceImages.length > 0 && !request.firstFrame && !request.lastFrame);
  const task = useReference ? "ref2va" : request.firstFrame || request.lastFrame ? "fl2va" : "t2va";
  const model = request.model ?? (useReference ? settings.video.referenceModel : settings.video.model);

  const conditions: Record<string, unknown>[] = [];
  if (useReference) {
    if (!referenceImages.length && !referenceVideos.length) throw new Error("ref2va 需要至少一张参考图或一段参考视频");
    for (const image of referenceImages) conditions.push({ type: "image", uri: await toDataUri(image), role: "reference" });
    for (const video of referenceVideos) conditions.push({ type: "video", uri: await toDataUri(video), role: "reference" });
  } else {
    if (request.firstFrame) conditions.push({ type: "image", uri: await toDataUri(request.firstFrame), role: "keyframe", frame_index: 0 });
    if (request.lastFrame) conditions.push({ type: "image", uri: await toDataUri(request.lastFrame), role: "keyframe", frame_index: -1 });
  }

  const payload: Record<string, unknown> = {
    model,
    prompt: request.prompt,
    seconds: duration,
    task,
    conditions,
    target: { short_edge: settings.video.shortEdge, aspect_ratio: ratio, duration_seconds: duration },
    num_outputs_per_prompt: 1,
    num_inference_steps: settings.video.steps,
    flow_shift: 12,
    audio_flow_shift: 3,
  };
  if (isOfficialPrompt(request.prompt)) payload.enhance_prompt = false;

  const signal = request.signal ?? new AbortController().signal;
  const timeout = AbortSignal.timeout(60_000);
  const requestSignal = AbortSignal.any([signal, timeout]);
  const created = await requestJson(`${baseUrl}/v1/videos`, apiKey, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  }, requestSignal);
  const videoId = typeof created.id === "string" ? created.id.trim() : "";
  if (!videoId) throw new Error("icompify 未返回任务 ID");
  request.onVideoId?.(videoId);

  const result = await pollVideoJob({
    videoId,
    task,
    model,
    signal,
    onProgress: request.onProgress,
    // 从创建时刻开始计时；恢复时由调用方传入任务原始 created_at。
    startedAt: Date.now(),
    maxWaitMs: settings.video.maxWaitMs,
    pollIntervalMs: settings.video.pollIntervalMs,
  });
  if (!("bytes" in result)) throw new Error(`icompify 任务未返回视频内容：${videoId}`);
  return result;
}

export type PollVideoJobOptions = {
  videoId: string;
  /** 恢复时未知，用 auto */
  task?: string;
  model?: string;
  signal: AbortSignal;
  onProgress?: (status: string, elapsedSeconds: number, percent?: number) => void;
  /** 任务创建时刻（毫秒）；省略则按「现在」算，用于 resume 时按真实排队时长判断超时 */
  startedAt?: number;
  maxWaitMs?: number;
  pollIntervalMs?: number;
  /** 只查一次状态，不等待、不下载 */
  once?: boolean;
};

/**
 * 轮询已有任务直到完成并下载。
 * 与 generateVideoJob 共用同一套逻辑，区别是这里不创建任务，所以恢复不会重复计费。
 */
export async function pollVideoJob(options: PollVideoJobOptions): Promise<VideoResult | { videoId: string; status: string; platform: Record<string, unknown> }> {
  const settings = await loadSettings();
  const apiKey = settings.video.apiKey.trim();
  if (!apiKey) throw new Error("尚未配置 icompify API Key");
  const baseUrl = settings.video.baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  const { videoId, signal } = options;
  const maxWaitMs = options.maxWaitMs ?? settings.video.maxWaitMs;
  const pollIntervalMs = options.pollIntervalMs ?? settings.video.pollIntervalMs;
  const started = options.startedAt ?? Date.now();

  const fetchInfo = () => requestJson(`${baseUrl}/v1/videos/${encodeURIComponent(videoId)}`, apiKey, {
    method: "GET",
    headers: { Accept: "application/json" },
  }, AbortSignal.any([signal, AbortSignal.timeout(60_000)]));

  // once 模式只查一次，供工具快速回报状态，不做长轮询。
  if (options.once) {
    const info = await fetchInfo();
    return { videoId, status: String(info.status ?? "").toLowerCase(), platform: info };
  }

  let failures = 0;
  while (true) {
    const elapsed = Math.round((Date.now() - started) / 1000);
    let info: Record<string, unknown>;
    try {
      info = await fetchInfo();
      failures = 0;
    } catch (error) {
      if (signal.aborted) throw error;
      failures += 1;
      // ACT: 单次查询失败不代表任务失败，连续 5 次才放弃；videoId 可继续恢复。
      if (failures >= 5) throw error;
      options.onProgress?.(`查询失败，重试 ${failures}/5`, elapsed);
      await wait(signal, pollIntervalMs);
      continue;
    }
    const status = String(info.status ?? "").toLowerCase();
    const percent = typeof info.progress === "number" ? info.progress : undefined;
    options.onProgress?.(status || "processing", elapsed, percent);
    if (status === "completed") {
      options.onProgress?.("下载中", elapsed);
      const response = await fetch(`${baseUrl}/v1/videos/${encodeURIComponent(videoId)}/content`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(600_000)]),
      });
      if (!response.ok) throw new Error(`icompify 视频下载失败：HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.byteLength) throw new Error("icompify 返回的视频内容为空");
      return {
        videoId,
        bytes,
        mimeType: "video/mp4",
        task: options.task ?? String(info.task ?? ""),
        model: options.model ?? String(info.model ?? ""),
        platform: info,
      };
    }
    if (status === "failed" || status === "cancelled" || status === "canceled") {
      throw new Error(`icompify 任务失败：${JSON.stringify(info).slice(0, 500)}`);
    }
    if (Date.now() - started > maxWaitMs) {
      throw new Error(`icompify 任务超过 ${Math.round(maxWaitMs / 60000)} 分钟仍未完成，video_id=${videoId}，可用 resume_shot 继续等待`);
    }
    await wait(signal, pollIntervalMs);
  }
}

export { officialMode };
