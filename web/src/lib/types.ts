export type ChatAttachment = {
  path: string;
  label?: string;
  kind?: "image" | "video";
  mimeType?: string;
  size?: number;
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  attachments?: ChatAttachment[];
};

export type ProjectSummary = {
  id: string;
  title: string;
  stage: string;
  shotCount: number;
  learning: string;
  createdAt?: string;
  updatedAt?: string;
};

export type StylePackSummary = {
  id: string;
  title: string;
  summary: string;
  characters: string[];
  shotCount: number;
};

export type SkillRating = "good" | "mixed" | "bad";

export type ShotSkillFeedback = {
  rating: SkillRating;
  at: string;
  count: number;
};

export type SkillSummary = {
  id: string;
  name: string;
  kind: string;
  /** 作用面：video=H3 分镜提示词，still=定妆照/场景照。 */
  appliesTo?: string[];
  status: string;
  confidence: number;
  summaryZh: string;
  instruction?: string;
  promptFragment?: string;
  applicableWhen?: string[];
  avoidWhen?: string[];
  tags?: string[];
  images?: string[];
  evidenceCount: number;
  uniqueProjects?: number;
  used: number;
  good: number;
  mixed: number;
  bad: number;
  needsFeedback?: boolean;
  source?: "local" | "public";
  lastOutcome?: {
    rating: SkillRating;
    projectId: string;
    shotId?: string;
    at: string;
  };
  updatedAt?: string;
};

export type LearningState = {
  status: string;
  warning?: string;
  error?: string;
  shotCount?: number;
  sourceDuration?: number;
  sourceWidth?: number;
  sourceHeight?: number;
};

export type Brief = {
  idea?: string;
  genre?: string;
  aspectRatio?: string;
  durationSeconds?: number;
  mustKeep?: string[];
  avoid?: string[];
};

export type BibleEntity = {
  id: string;
  name: string;
  descriptionZh: string;
  stillImages?: string[];
};

export type CameraMove = {
  name: string;
  descriptionZh?: string;
  promptFragment?: string;
};

export type StyleBible = {
  summary: string;
  characters?: BibleEntity[];
  locations?: BibleEntity[];
  cameraGrammar?: CameraMove[];
  rhythm?: { averageShotSeconds?: number | string };
  style?: { stylePrefix?: string };
};

export type AssetRecord = {
  kind: string;
  path: string;
  label: string;
  meta?: Record<string, unknown>;
};

export type PlanShot = {
  id: string;
  title: string;
  action?: string;
  durationSeconds: number;
  status: string;
  video?: string;
  prompt?: string;
  promptMode?: string;
  error?: string;
  skillIds?: string[];
  skillFeedback?: ShotSkillFeedback;
};

export type Project = {
  id: string;
  title: string;
  stage: string;
  updatedAt: string;
  brief?: Brief;
  learning?: LearningState;
  styleBible?: StyleBible | null;
  plan?: PlanShot[];
  assets?: AssetRecord[];
};

export type ReferenceShot = {
  id: string;
  start: number;
  end: number;
  duration: number;
  keyframe: string;
  clip?: string;
  shotSize?: string;
  movement?: string;
  description?: string;
};

export type RenderJob = {
  id: string;
  shotId: string;
  status: string;
  percent?: number;
  label?: string;
  startedAt?: string;
  videoId?: string;
  video?: string;
  error?: string;
};

export type PendingUpload = {
  file: File;
  kind: "image" | "video";
  previewUrl: string;
  status: "uploading" | "done" | "error";
  error?: string;
  asset?: AssetRecord;
  mimeType?: string;
  size?: number;
};

export type ToolCardState = {
  id: string;
  name: string;
  args: unknown;
  status: "running" | "done" | "failed";
  percent: number;
  label: string;
  panel: boolean;
  startedAt: number;
  elapsedMs?: number;
  preview?: string;
};

export type ChatItem =
  | {
      kind: "bubble";
      id: string;
      role: "user" | "assistant";
      content: string;
      isError?: boolean;
      attachments?: ChatAttachment[];
    }
  | {
      kind: "tool";
      id: string;
      card: ToolCardState;
    }
  | {
      kind: "confirm";
      id: string;
      shotId: string;
      title: string;
      durationSeconds?: number;
      /** 该镜头已有未完成任务，提交会二次计费；卡片要显式提示。 */
      force?: boolean;
      status: "pending" | "submitted" | "declined";
    };

export type MediaRequest = {
  src: string;
  type?: string;
  title?: string;
  openUrl?: string;
};

export type InspectorTab = "overview" | "shots" | "jobs" | "assets" | "skills";

export type AppSettings = Record<string, unknown> & {
  llm?: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    visionModel?: string;
  };
  video?: {
    provider?: string;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    referenceModel?: string;
    local?: {
      baseUrl?: string;
      token?: string;
      shortEdge?: number | string;
    };
  };
  image?: {
    api?: string;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    size?: string;
    local?: Record<string, unknown>;
  };
  xhs?: Record<string, unknown>;
};
