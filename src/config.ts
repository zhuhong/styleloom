import { join, resolve } from "node:path";
import { readJsonIfExists, writeJson } from "./util/fs";

export type Settings = {
  server: { host: string; port: number };
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
    visionModel: string;
    temperature: number;
    maxTokens: number;
  };
  video: {
    provider: "icompify" | "local";
    baseUrl: string;
    apiKey: string;
    model: string;
    referenceModel: string;
    shortEdge: number;
    aspectRatio: string;
    steps: number;
    pollIntervalMs: number;
    maxWaitMs: number;
    /** 本地 GPU 上的视频网关；provider=local 时生效。 */
    local: {
      baseUrl: string;
      /** 网关启动时 --token 对应的口令，走 X-Toonflow-Gateway-Token 头。 */
      token: string;
      /** 输出短边，长边按画幅比例推算，并对齐 32。 */
      shortEdge: number;
    };
  };
  image: {
    api: "auto" | "openai" | "openrouter" | "local";
    baseUrl: string;
    apiKey: string;
    model: string;
    size: string;
    /** 本地 GPU 出图脚本：本机直连（direct）或 SSH 调用远端脚本（ssh）。 */
    local: {
      /**
       * auto = 本机存在脚本与 Python 就直连，否则配了 host 就走 SSH；
       * direct = 只在本机 spawn；ssh = 只走 SSH 远端。
       */
      mode: "auto" | "direct" | "ssh";
      host: string;
      sshBin: string;
      scpBin: string;
      pythonBin: string;
      script: string;
      workdir: string;
      /** 输出短边，长边按画幅比例推算；默认 16:9 = 1344x768。 */
      shortEdge: number;
      steps: number;
      vram: "auto" | "cuda" | "offload";
      timeoutMs: number;
    };
  };
  xhs: {
    ytDlpPath: string;
    /** chrome / safari / firefox / edge；留空表示不读取浏览器 Cookie */
    cookiesFromBrowser: string;
    referer: string;
    userAgent: string;
    timeoutMs: number;
  };
  ffmpeg: { ffmpegPath: string; ffprobePath: string };
  learning: {
    sceneThreshold: number;
    minShotSeconds: number;
    maxShots: number;
    sampleCount: number;
    keepClips: boolean;
  };
};

export const appRoot = resolve(import.meta.dir, "..");
export const webDir = join(appRoot, "web");
export const dataDir = process.env.VIDEOCOPY_DATA ? resolve(process.env.VIDEOCOPY_DATA) : join(appRoot, "data");
export const settingsPath = join(dataDir, "settings.json");

export const defaultSettings: Settings = {
  server: { host: "127.0.0.1", port: 8787 },
  llm: {
    baseUrl: "http://localhost:4000/v1",
    apiKey: "",
    model: "deepseek-v4.1-flash",
    visionModel: "deepseek-v4.1-flash",
    temperature: 0.6,
    maxTokens: 8192,
  },
  video: {
    provider: "icompify",
    baseUrl: "https://api.icompify.com",
    apiKey: "",
    model: "minimax-h3-fl2va",
    referenceModel: "minimax-h3-ref2va",
    shortEdge: 768,
    aspectRatio: "16:9",
    steps: 50,
    pollIntervalMs: 10000,
    // 平台排队时间不可控，60 分钟曾出现排队未开始推理；放宽到 120 分钟，
    // 真正兜底靠 resume_shot 接回，而不是靠超时。
    maxWaitMs: 7200000,
    local: {
      baseUrl: "http://127.0.0.1:8000",
      token: "",
      shortEdge: 480,
    },
  },
  image: {
    api: "auto",
    baseUrl: "",
    apiKey: "",
    model: "",
    size: "2K",
    local: {
      mode: "auto",
      host: "",
      sshBin: "ssh",
      scpBin: "scp",
      // 留空表示未配置本地出图；填写方式见 docs/local-gpu.md
      pythonBin: "",
      script: "",
      workdir: "",
      shortEdge: 768,
      steps: 8,
      vram: "offload",
      timeoutMs: 900_000,
    },
  },
  xhs: {
    ytDlpPath: "yt-dlp",
    cookiesFromBrowser: "chrome",
    referer: "https://www.xiaohongshu.com",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    timeoutMs: 300_000,
  },
  ffmpeg: { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" },
  learning: { sceneThreshold: 0.32, minShotSeconds: 0.6, maxShots: 40, sampleCount: 3, keepClips: true },
};

function mergeSection<T extends object>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
  const merged = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const current = merged[key];
    merged[key] = current && typeof current === "object" && !Array.isArray(current) && value && typeof value === "object" && !Array.isArray(value)
      ? { ...(current as object), ...(value as object) }
      : value;
  }
  return merged as T;
}

export function normalizeSettings(input: unknown): Settings {
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const settings: Settings = {
    server: mergeSection(defaultSettings.server, raw.server),
    llm: mergeSection(defaultSettings.llm, raw.llm),
    video: mergeSection(defaultSettings.video, raw.video),
    image: mergeSection(defaultSettings.image, raw.image),
    xhs: mergeSection(defaultSettings.xhs, raw.xhs),
    ffmpeg: mergeSection(defaultSettings.ffmpeg, raw.ffmpeg),
    learning: mergeSection(defaultSettings.learning, raw.learning),
  };
  settings.server.port = Number(settings.server.port) || defaultSettings.server.port;
  settings.video.shortEdge = Number(settings.video.shortEdge) || defaultSettings.video.shortEdge;
  settings.video.steps = Number(settings.video.steps) || defaultSettings.video.steps;
  settings.video.pollIntervalMs = Number(settings.video.pollIntervalMs) || defaultSettings.video.pollIntervalMs;
  settings.video.maxWaitMs = Number(settings.video.maxWaitMs) || defaultSettings.video.maxWaitMs;
  if (!["icompify", "local"].includes(settings.video.provider)) settings.video.provider = defaultSettings.video.provider;
  if (!settings.video.local || typeof settings.video.local !== "object") settings.video.local = { ...defaultSettings.video.local };
  settings.video.local.shortEdge = Math.min(1024, Math.max(256, Number(settings.video.local.shortEdge) || defaultSettings.video.local.shortEdge));
  if (!settings.image.local || typeof settings.image.local !== "object") settings.image.local = { ...defaultSettings.image.local };
  if (!["auto", "direct", "ssh"].includes(settings.image.local.mode)) settings.image.local.mode = defaultSettings.image.local.mode;
  settings.image.local.shortEdge = Math.min(2048, Math.max(256, Number(settings.image.local.shortEdge) || defaultSettings.image.local.shortEdge));
  settings.image.local.steps = Math.min(50, Math.max(1, Number(settings.image.local.steps) || defaultSettings.image.local.steps));
  settings.image.local.timeoutMs = Math.max(30_000, Number(settings.image.local.timeoutMs) || defaultSettings.image.local.timeoutMs);
  if (!["auto", "cuda", "offload"].includes(settings.image.local.vram)) settings.image.local.vram = defaultSettings.image.local.vram;
  if (!["auto", "openai", "openrouter", "local"].includes(settings.image.api)) settings.image.api = "auto";
  settings.learning.sceneThreshold = Number(settings.learning.sceneThreshold) || defaultSettings.learning.sceneThreshold;
  settings.learning.maxShots = Math.min(200, Math.max(1, Number(settings.learning.maxShots) || defaultSettings.learning.maxShots));
  settings.learning.sampleCount = Math.min(3, Math.max(1, Number(settings.learning.sampleCount) || defaultSettings.learning.sampleCount));
  settings.xhs.timeoutMs = Math.max(30_000, Number(settings.xhs.timeoutMs) || defaultSettings.xhs.timeoutMs);
  return settings;
}

let cached: Settings | undefined;

export async function loadSettings(force = false): Promise<Settings> {
  if (cached && !force) return cached;
  const file = await readJsonIfExists<unknown>(settingsPath);
  cached = normalizeSettings(file);
  return cached;
}

export async function saveSettings(next: Settings) {
  cached = normalizeSettings(next);
  await writeJson(settingsPath, cached);
  return cached;
}

const mask = "********";

export function maskSettings(settings: Settings) {
  return {
    ...settings,
    llm: { ...settings.llm, apiKey: settings.llm.apiKey ? mask : "" },
    video: {
      ...settings.video,
      apiKey: settings.video.apiKey ? mask : "",
      local: { ...settings.video.local, token: settings.video.local.token ? mask : "" },
    },
    image: { ...settings.image, apiKey: settings.image.apiKey ? mask : "" },
  };
}

/** 前端回传打码占位符时保留原密钥。 */
export function preserveSecrets(incoming: Settings, current: Settings): Settings {
  const next = normalizeSettings(incoming);
  if (next.llm.apiKey === mask) next.llm.apiKey = current.llm.apiKey;
  if (next.video.apiKey === mask) next.video.apiKey = current.video.apiKey;
  if (next.video.local.token === mask) next.video.local.token = current.video.local.token;
  if (next.image.apiKey === mask) next.image.apiKey = current.image.apiKey;
  return next;
}

