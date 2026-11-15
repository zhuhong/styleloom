export type VideoJob = {
  prompt: string;
  durationSeconds: number;
  aspectRatio?: string;
  firstFrame?: string;
  lastFrame?: string;
  referenceImages?: string[];
  referenceVideos?: string[];
  model?: string;
  signal?: AbortSignal;
  onProgress?: (status: string, elapsedSeconds: number, percent?: number) => void;
  onVideoId?: (videoId: string) => void;
};

export type VideoResult = {
  videoId: string;
  bytes: Uint8Array;
  mimeType: string;
  task: string;
  model: string;
  platform: Record<string, unknown>;
  /** 后端能力边界导致的降级说明，例如本地 ref2va 只用了第 1 张参考图 */
  notes?: string[];
};
