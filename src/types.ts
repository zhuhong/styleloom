/** 领域模型：项目、切片清单、学习成果（风格圣经）、分镜与素材。 */

export type Stage = "brief" | "study" | "plan" | "generate" | "deliver";

export type Brief = {
  idea: string;
  genre?: string;
  durationSeconds?: number;
  aspectRatio?: string;
  language?: string;
  mustKeep: string[];
  avoid: string[];
  notes?: string;
};

export type LearningStatus = "none" | "slicing" | "annotating" | "distilling" | "done" | "failed";

export type LearningState = {
  status: LearningStatus;
  source?: string;
  focus?: string;
  shotCount?: number;
  sourceDuration?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  error?: string;
  warning?: string;
  skills?: { created: number; merged: number };
  updatedAt?: string;
};

export type ShotAnnotation = {
  shotSize: string;
  cameraAngle: string;
  movement: string;
  lighting: string;
  palette: string;
  composition: string;
  lens: string;
  subject: string;
  wardrobe: string;
  setting: string;
  action: string;
  expression: string;
  dialogue: string;
  sound: string;
  styleTags: string[];
  description: string;
  h3ShotBlock: string;
};

export type SliceShot = {
  id: string;
  index: number;
  start: number;
  end: number;
  duration: number;
  /** 相对项目目录的路径 */
  keyframe: string;
  samples: string[];
  clip?: string;
  annotation?: ShotAnnotation;
};

export type SliceManifest = {
  source: string;
  sourceName: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  method: "scene" | "interval";
  shots: SliceShot[];
  audio?: string;
  createdAt: string;
};

export type CharacterSheet = {
  id: string;
  name: string;
  /** 中文描述，给人和 Agent 看 */
  descriptionZh: string;
  /** 英文身份锚点，进入提示词 */
  identity: string;
  wardrobe: string;
  distinctiveFeatures: string[];
  refShotIds: string[];
  /** 相对项目目录的参考图 */
  refImages: string[];
  /** 生成出来的定妆照 */
  stillImages: string[];
  stillPrompt: string;
};

export type LocationSheet = {
  id: string;
  name: string;
  descriptionZh: string;
  promptEn: string;
  timeOfDay: string;
  lighting: string;
  refShotIds: string[];
  refImages: string[];
  stillImages: string[];
  stillPrompt: string;
};

export type CameraMove = {
  name: string;
  descriptionZh: string;
  amplitude: string;
  speed: string;
  motivation: string;
  /** 直接可用的英文运镜片段 */
  promptFragment: string;
  exampleShotIds: string[];
};

export type StyleBible = {
  version: 1;
  createdAt: string;
  source: {
    projectId?: string;
    projectTitle?: string;
    sourceName?: string;
    shotCount: number;
    durationSeconds: number;
  };
  summary: string;
  style: {
    genre: string;
    filmLook: string;
    colorGrade: string;
    lighting: string;
    lensPackage: string;
    aspectRatio: string;
    texture: string;
    /** 每次生成时放在 [Shot 1] 开头的风格句 */
    stylePrefix: string;
  };
  characters: CharacterSheet[];
  locations: LocationSheet[];
  cameraGrammar: CameraMove[];
  rhythm: {
    averageShotSeconds: number;
    shotCount: number;
    cutPattern: string;
    notes: string;
  };
  prompting: {
    consistencyAnchors: string[];
    avoid: string[];
    promptPatterns: string[];
  };
  sound: {
    ambience: string;
    music: string;
    mixNotes: string;
  };
};

export type ShotStatus = "planned" | "promptReady" | "generating" | "done" | "failed";

export type ShotReferenceImage = {
  path: string;
  role: "subject" | "location";
  label?: string;
};

export type ShotReferenceVideo = {
  path: string;
  label?: string;
};

export type ChatAttachment = {
  path: string;
  label: string;
  kind: "image" | "video";
  mimeType?: string;
  size?: number;
};

export type ShotPlan = {
  id: string;
  index: number;
  title: string;
  /** 分镜时长 1-15 秒；H3 常规下限 4 秒，低于 4 秒由生成层裁剪或实验直发 */
  durationSeconds: number;
  action: string;
  dialogue?: string;
  camera: string;
  lighting?: string;
  sound?: string;
  characterIds: string[];
  locationId?: string;
  /** 参考片镜头 id，用于 ref2va 传递运镜/节奏 */
  referenceShotIds: string[];
  /** 本次实际采用的全局技能 */
  skillIds?: string[];
  /** 生成模式；auto 时按素材自动选择 */
  generationMode?: GenerationMode;
  firstFrame?: string;
  lastFrame?: string;
  /** 用户上传或项目内图片，作为 Ref2VA 参考图 */
  referenceImages?: ShotReferenceImage[];
  /** 用户上传或项目内视频，作为 Ref2VA 参考视频 */
  referenceVideos?: ShotReferenceVideo[];
  status: ShotStatus;
  prompt?: string;
  promptMode?: PromptMode;
  video?: string;
  videoId?: string;
  error?: string;
  updatedAt?: string;
};

export type PromptMode = "t2va" | "i2va" | "fl2va" | "l2va" | "ref2va";
export type GenerationMode = PromptMode | "auto";

export type AssetKind = "still" | "video" | "frame" | "clip" | "audio" | "source" | "upload";

export type AssetRecord = {
  id: string;
  kind: AssetKind;
  /** 相对项目目录 */
  path: string;
  label: string;
  createdAt: string;
  meta?: Record<string, unknown>;
};

export type Project = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  stage: Stage;
  brief: Brief;
  learning: LearningState;
  styleBible?: StyleBible;
  libraryPackId?: string;
  plan: ShotPlan[];
  assets: AssetRecord[];
};

export type ProjectSummary = {
  id: string;
  title: string;
  stage: Stage;
  updatedAt: string;
  shotCount: number;
  learning: LearningStatus;
  hasBible: boolean;
};

export type AgentEvent =
  | { type: "message"; role: "user" | "assistant"; content: string; attachments?: ChatAttachment[] }
  | { type: "tool_start"; id: string; name: string; args: unknown }
  | { type: "tool_end"; id: string; name: string; ok: boolean; preview: string; elapsedMs: number }
  | { type: "progress"; scope: string; percent: number; label: string }
  | { type: "state"; project: Project }
  | { type: "error"; message: string }
  | { type: "ping" }
  | { type: "done" };

/** 全局技能：跨项目复用的可执行方法，不等于某个项目的风格圣经。 */
export type SkillKind = "camera" | "lighting" | "color" | "composition" | "rhythm" | "prompt" | "sound" | "workflow" | "avoid";

export type SkillStatus = "candidate" | "active" | "deprecated";

export type SkillEvidence = {
  projectId: string;
  projectTitle: string;
  sourceName?: string;
  shotIds: string[];
  note?: string;
  /** 相对技能目录的证据图 */
  image?: string;
  addedAt: string;
};

export type SkillOutcome = {
  projectId: string;
  shotId?: string;
  rating: "good" | "mixed" | "bad";
  notes?: string;
  at: string;
};

export type SkillRevision = {
  version: number;
  at: string;
  change: string;
  confidence: number;
};

export type SkillDraft = {
  name: string;
  kind: SkillKind;
  summaryZh: string;
  instruction: string;
  promptFragment: string;
  applicableWhen: string[];
  avoidWhen: string[];
  tags: string[];
  evidenceShotIds?: string[];
  confidence?: number;
};

export type Skill = {
  id: string;
  name: string;
  kind: SkillKind;
  status: SkillStatus;
  summaryZh: string;
  instruction: string;
  promptFragment: string;
  applicableWhen: string[];
  avoidWhen: string[];
  tags: string[];
  evidence: SkillEvidence[];
  outcomes: SkillOutcome[];
  stats: { used: number; reads: number; good: number; mixed: number; bad: number; lastUsedAt?: string };
  confidence: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  revisions: SkillRevision[];
  mergedInto?: string;
  /** 人工指定状态后不再自动升降级 */
  statusLocked?: boolean;
  /** 来源：public=仓库公开技能库（只读）；local=本机累积（默认）。 */
  source?: "public" | "local";
};

/** 公开技能库条目：随仓库分发的知识，不含证据图、反馈与置信度等私有/版权字段。 */
export type PublicSkill = {
  id: string;
  name: string;
  kind: SkillKind;
  summaryZh: string;
  instruction: string;
  promptFragment: string;
  applicableWhen: string[];
  avoidWhen: string[];
  tags: string[];
  version: number;
  createdAt?: string;
};
