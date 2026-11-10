import type { Project, PromptMode, ShotPlan, StyleBible } from "../types";
import { chat } from "../providers/llm";
import { loadSettings } from "../config";
import { getManifest } from "../store/projects";

export type ReferenceImage = { path: string; label: string; role: "subject" | "location" };
export type ReferenceVideo = { path: string; label: string; shotId: string };

export type PreparedReferences = {
  mode: PromptMode;
  firstFrame?: string;
  lastFrame?: string;
  images: ReferenceImage[];
  videos: ReferenceVideo[];
};

function characterStill(character: NonNullable<StyleBible["characters"]>[number]) {
  return character.stillImages[0] ?? character.refImages[0];
}

/** 依据分镜与学习成果决定 H3 生成模式，并准备参考素材。 */
export async function prepareReferences(project: Project, shot: ShotPlan): Promise<PreparedReferences> {
  const bible = project.styleBible;
  const images: ReferenceImage[] = [];
  if (bible) {
    for (const characterId of shot.characterIds) {
      const character = bible.characters.find(item => item.id === characterId);
      const path = character ? characterStill(character) : undefined;
      if (character && path) images.push({ path, label: `${character.identity}${character.wardrobe ? `, wearing ${character.wardrobe}` : ""}`, role: "subject" });
    }
    if (shot.locationId) {
      const location = bible.locations.find(item => item.id === shot.locationId);
      const path = location ? location.stillImages[0] ?? location.refImages[0] : undefined;
      if (location && path) images.push({ path, label: location.promptEn, role: "location" });
    }
  }

  const manifest = await getManifest(project);
  const videos: ReferenceVideo[] = [];
  for (const shotId of shot.referenceShotIds) {
    const source = manifest?.shots.find(item => item.id === shotId);
    if (source?.clip) videos.push({ path: source.clip, label: `${shotId} camera movement and pacing reference`, shotId });
  }

  const forced = shot.generationMode && shot.generationMode !== "auto" ? shot.generationMode : undefined;
  if (forced === "t2va") return { mode: "t2va", images: [], videos: [] };
  if (forced === "ref2va") {
    if (!images.length && !videos.length) throw new Error("Ref2VA 需要至少一张参考图或一段参考视频");
    return { mode: "ref2va", images: images.slice(0, 4), videos: videos.slice(0, 3) };
  }
  if (forced === "i2va") {
    const firstFrame = shot.firstFrame ?? images.find(image => image.role === "subject")?.path ?? images[0]?.path;
    if (!firstFrame) throw new Error("I2VA 需要首帧图片");
    return { mode: "i2va", firstFrame, images: [], videos: [] };
  }
  if (forced === "fl2va") {
    if (!shot.firstFrame || !shot.lastFrame) throw new Error("FL2VA 需要首帧和尾帧");
    return { mode: "fl2va", firstFrame: shot.firstFrame, lastFrame: shot.lastFrame, images: [], videos: [] };
  }
  if (forced === "l2va") {
    if (!shot.lastFrame) throw new Error("L2VA 需要尾帧");
    return { mode: "l2va", lastFrame: shot.lastFrame, images: [], videos: [] };
  }
  if (shot.firstFrame) {
    return { mode: shot.lastFrame ? "fl2va" : "i2va", firstFrame: shot.firstFrame, lastFrame: shot.lastFrame, images, videos: [] };
  }
  if (videos.length) {
    return { mode: "ref2va", images: images.slice(0, 4), videos: videos.slice(0, 3) };
  }
  const firstImage = images.find(image => image.role === "subject") ?? images[0];
  if (firstImage) {
    return { mode: "i2va", firstFrame: firstImage.path, images, videos: [] };
  }
  return { mode: "t2va", images, videos: [] };
}

export function alignmentLine(mode: PromptMode, duration: number) {
  const seconds = duration.toFixed(2);
  if (mode === "i2va") return "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.";
  if (mode === "fl2va") return `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the ${seconds}-second mark of the target video.`;
  if (mode === "l2va") return `How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the ${seconds}-second mark of the target video.`;
  return "";
}

function clip(value: string, max: number) {
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function dialogueBlock(dialogue: string, characters: string[]) {
  const text = dialogue.trim();
  if (!text) return "";
  const language = /[\u3400-\u9fff]/.test(text) ? "Chinese" : "English";
  const speaker = characters[0] || "the main character";
  return `${speaker} (S1) says: <d>[${language}] ${text}</d>`;
}

function subjectLines(shot: ShotPlan, bible?: StyleBible) {
  if (!bible) return "";
  const characters = shot.characterIds
    .map(id => bible.characters.find(character => character.id === id))
    .filter((character): character is NonNullable<typeof character> => Boolean(character));
  const location = bible.locations.find(item => item.id === shot.locationId);
  const parts = characters.slice(0, 3).map(character => `The recurring character ${clip(character.identity, 220)}${character.wardrobe ? `, wearing ${clip(character.wardrobe, 120)}` : ""} stays consistent.`);
  if (location) parts.push(`The scene remains ${clip(location.promptEn, 260)}.`);
  return clip(parts.join(" "), 900);
}

function commonDescription(shot: ShotPlan, bible: StyleBible | undefined, duration: number) {
  const style = clip(bible?.style.stylePrefix ?? "Cinematic live-action with natural skin tones, motivated lighting and restrained color separation.", 320);
  const anchors = bible?.prompting.consistencyAnchors?.length ? clip(`Keep consistent: ${bible.prompting.consistencyAnchors.join("; ")}.`, 560) : "";
  const subjects = subjectLines(shot, bible);
  const action = clip(shot.action || "The subject holds a subtle, natural pose and slowly shifts weight.", 900);
  const camera = clip(shot.camera || "The camera holds a stable, motivated frame.", 520);
  const lighting = clip(shot.lighting || bible?.style.lighting || "Motivated soft key light with natural falloff.", 420);
  const dialogue = dialogueBlock(shot.dialogue ?? "", shot.characterIds.length ? [subjectName(shot, bible)] : []);
  return `[Shot 1] ${style} ${subjects} ${action} ${camera} ${lighting}${dialogue ? ` ${dialogue}` : ""} The action runs for ${duration.toFixed(2)} seconds with physically plausible momentum, contact, secondary motion and a settled result. ${anchors}`.replace(/\s+/g, " ").trim();
}

function subjectName(shot: ShotPlan, bible?: StyleBible) {
  const character = bible?.characters.find(item => shot.characterIds.includes(item.id));
  return character ? character.identity.split(",")[0] : "The main character";
}

function soundBlock(shot: ShotPlan, bible?: StyleBible) {
  return shot.sound || bible?.sound.ambience || "Natural room tone and subtle synchronized physical action sounds.";
}

function musicBlock(bible?: StyleBible) {
  return bible?.sound.music && bible.sound.music.toLowerCase() !== "n/a" ? bible.sound.music : "N/A";
}

/** 确定性三段式 / 六段式骨架，同时也是 LLM 失败时的兜底。 */
export function buildPromptSkeleton(input: {
  shot: ShotPlan;
  bible?: StyleBible;
  mode: PromptMode;
  duration: number;
  references: PreparedReferences;
}) {
  const { shot, bible, mode, duration, references } = input;
  const description = commonDescription(shot, bible, duration);
  const sound = `overall_soundscape: ${soundBlock(shot, bible)}`;
  const music = `non_diegetic_music: ${musicBlock(bible)}`;
  if (mode !== "ref2va") {
    const alignment = alignmentLine(mode, duration);
    return `${alignment ? `${alignment}\n\n` : ""}integrated_multimodal_description: ${description}\n\n${sound}\n\n${music}`;
  }

  const subjects = references.images.filter(image => image.role === "subject");
  const locations = references.images.filter(image => image.role === "location");
  const definitions: string[] = [];
  subjects.forEach((image, index) => {
    definitions.push(clip(`<Subject ${index + 1}> is ${image.label}.`, 300));
  });
  references.images.forEach((image, index) => {
    definitions.push(image.role === "subject"
      ? `<Picture ${index + 1}> is the reference still defining the appearance and wardrobe of <Subject ${subjects.findIndex(subject => subject.path === image.path) + 1}>.`
      : clip(`<Picture ${index + 1}> is the reference still defining this location: ${image.label}.`, 300));
  });
  references.videos.forEach((video, index) => {
    definitions.push(`<Video ${index + 1}> is the reference video providing camera movement, framing rhythm and pacing from shot ${video.shotId}; do not copy its subject identity.`);
  });
  const retention = [
    ...subjects.map((_, index) => `<Subject ${index + 1}>: fully_preserved`),
    ...references.images.map((image, index) => `<Picture ${index + 1}>: ${image.role === "subject" ? "partially_preserved" : "attribute_transfer"}`),
    ...references.videos.map((_, index) => `<Video ${index + 1}>: partially_preserved`),
  ];
  return `subject_definitions:
${definitions.join("\n")}

summary: [reference generation + synchronized audio] ${shot.action || "A short cinematic shot built from the learned style."}

retention_analysis:
${retention.join("\n")}

detailed_description: ${description}

${sound}

${music}`;
}

const requiredBase = ["integrated_multimodal_description:", "overall_soundscape:", "non_diegetic_music:"];
const requiredRef = ["subject_definitions:", "summary:", "retention_analysis:", "detailed_description:", "overall_soundscape:", "non_diegetic_music:"];

export function validatePrompt(prompt: string, mode: PromptMode, duration: number) {
  const problems: string[] = [];
  const text = prompt.trim();
  if (!text) return ["提示词为空"];
  if (text.length > 7000) problems.push(`提示词长度 ${text.length} 超过 H3 上限 7000`);
  const required = mode === "ref2va" ? requiredRef : requiredBase;
  let lastIndex = -1;
  for (const field of required) {
    const index = text.indexOf(field);
    if (index === -1) problems.push(`缺少字段 ${field}`);
    else if (index < lastIndex) problems.push(`字段顺序错误 ${field}`);
    else lastIndex = index;
  }
  const alignment = alignmentLine(mode, duration);
  if (alignment && !text.startsWith(alignment)) problems.push(`${mode.toUpperCase()} 首行对齐句缺失或被改写`);
  if (mode === "fl2va" && !text.includes("Picture 2")) problems.push("FL2VA 缺少尾帧 Picture 2 引用");
  return problems;
}

function stripFences(text: string) {
  const cleaned = text.trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/i, "").trim();
  const anchors = ["For the target video", "How the reference pictures align", "integrated_multimodal_description:", "subject_definitions:"];
  const indexes = anchors.map(anchor => cleaned.indexOf(anchor)).filter(index => index >= 0);
  if (!indexes.length) return cleaned;
  return cleaned.slice(Math.min(...indexes)).trim();
}

const writingSystem = `You are a MiniMax H3 prompt director. Write the final English prompt only. No markdown fences, no commentary, no self-check.
H3 modes: T2VA (text only), I2VA (Picture 1 is the exact first frame), FL2VA (Picture 1 first frame, Picture 2 last frame), L2VA (Picture 1 exact last frame), R2VA (reference images/videos, not exact keyframes).
I2VA first line must be exactly: For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.
FL2VA first line must be exactly: How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the S.SS-second mark of the target video.
L2VA first line must be exactly: How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the S.SS-second mark of the target video.
T2VA and R2VA have no alignment line.
Base structure, with blank lines between fields:
integrated_multimodal_description: [Shot 1] ...
overall_soundscape: ...
non_diegetic_music: ...
R2VA uses six fields in this exact order: subject_definitions, summary (start with a bracketed task prefix such as [reference generation]), retention_analysis, detailed_description, overall_soundscape, non_diegetic_music. No alignment line. Define every <Subject N>, <Picture N>, <Video N>; use retention markers fully_preserved / partially_preserved / attribute_transfer / weak_reference.
Rules: single continuous shot; describe style, framing, subject identity, action cause-and-effect, camera move type + amplitude + speed + motivation, lighting, materials, expression, gaze and synchronized diegetic sound along the timeline. Prefer one camera move. Dialogue stays verbatim with (S1) and <d>[Language] ...</d>. No negative-prompt sections, no claims of native 8K, no decorative adjective piles. Keep under 7000 characters.`;

export async function composeShotPrompt(input: {
  shot: ShotPlan;
  bible?: StyleBible;
  mode: PromptMode;
  duration: number;
  aspectRatio: string;
  references: PreparedReferences;
  signal?: AbortSignal;
}): Promise<{ prompt: string; source: "llm" | "template"; problems: string[] }> {
  const { shot, bible, mode, duration, aspectRatio, references } = input;
  const skeleton = buildPromptSkeleton({ shot, bible, mode, duration, references });
  const settings = await loadSettings();
  if (!settings.llm.model.trim() || !settings.llm.baseUrl.trim()) {
    return { prompt: skeleton, source: "template", problems: [] };
  }
  const payload = {
    mode,
    durationSeconds: duration,
    aspectRatio,
    shot: {
      title: shot.title,
      action: shot.action,
      dialogue: shot.dialogue,
      camera: shot.camera,
      lighting: shot.lighting,
      sound: shot.sound,
    },
    style: bible?.style,
    characters: shot.characterIds.map(id => bible?.characters.find(character => character.id === id)).filter(Boolean),
    location: bible?.locations.find(location => location.id === shot.locationId),
    consistencyAnchors: bible?.prompting.consistencyAnchors,
    avoid: bible?.prompting.avoid,
    references: {
      images: references.images.map((image, index) => ({ label: `<Picture ${index + 1}>`, role: image.role, description: image.label })),
      videos: references.videos.map((video, index) => ({ label: `<Video ${index + 1}>`, description: video.label })),
    },
  };
  try {
    const result = await chat({
      messages: [
        { role: "system", content: writingSystem },
        { role: "user", content: `Create the final H3 prompt from this JSON:\n${JSON.stringify(payload)}\n\nFallback skeleton for structure (improve it, keep the structure):\n${skeleton}` },
      ],
      temperature: 0.4,
      maxTokens: 5000,
      signal: input.signal,
      timeoutMs: 180_000,
    });
    let prompt = stripFences(result.content);
    let problems = validatePrompt(prompt, mode, duration);
    if (problems.some(problem => problem.includes("7000"))) {
      // ACT: 超长时再请求一次压缩，避免直接退回信息量更低的模板。
      const compressed = await chat({
        messages: [
          { role: "system", content: writingSystem },
          { role: "user", content: `Compress this H3 prompt to under 6600 characters. Keep every required field, the exact alignment line, all reference labels, the action timeline and dialogue verbatim. Remove redundant adjectives and repeated style words only. Output the prompt only.\n\n${prompt}` },
        ],
        temperature: 0.2,
        maxTokens: 4000,
        signal: input.signal,
        timeoutMs: 180_000,
      });
      prompt = stripFences(compressed.content);
      problems = validatePrompt(prompt, mode, duration);
    }
    if (problems.length) return { prompt: skeleton, source: "template", problems };
    return { prompt, source: "llm", problems: [] };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return { prompt: skeleton, source: "template", problems: [`提示词模型调用失败：${error instanceof Error ? error.message : String(error)}`] };
  }
}
