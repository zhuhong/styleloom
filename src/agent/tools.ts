import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { dataDir } from "../config";
import type { Settings } from "../config";
import type { AgentEvent, PromptMode, Project, ShotPlan, ShotReferenceImage, ShotReferenceVideo, SkillKind, Stage, StyleBible } from "../types";
import type { ToolSpec } from "../providers/llm";
import { copyInto, ensureDir, exists, nowIso, safeJoin } from "../util/fs";
import { addAsset, getManifest, projectDir } from "../store/projects";
import { applyStylePack, listStylePacks } from "../store/library";
import { studyReferenceVideo } from "../learn/study";
import { generateShot } from "../generate/shot";
import { generateStill } from "../generate/still";
import { stitchShots } from "../generate/stitch";
import { H3_SAFE_MIN_SECONDS, normalizeShotDuration } from "../util/duration";
import { composeShotPrompt, prepareReferences } from "../generate/prompt";
import { downloadXhsVideo, extractUrlFromText, isXhsUrl } from "../providers/download/xhs";
import { exportPublicSkill, mergeSkills, readSkillResolved, recordSkillOutcome, searchSkills, skillToSummary, updateSkill } from "../store/skills";
import { extractSkillsFromStudy } from "../learn/skills";
import { normalizeStyleBible } from "../learn/bible";

export type ToolContext = {
  project: Project;
  settings: Settings;
  emit: (event: AgentEvent) => void;
  signal: AbortSignal;
  save: () => Promise<void>;
};

type Args = Record<string, unknown>;

function record(value: unknown): Args {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Args) : {};
}

function reqString(args: Args, name: string) {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`参数 ${name} 必须是非空字符串`);
  return value.trim();
}

function optString(args: Args, name: string) {
  const value = args[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optNumber(args: Args, name: string) {
  const value = args[name];
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`参数 ${name} 必须是数字`);
  return number;
}

function stringArray(args: Args, name: string) {
  const value = args[name];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map(item => item.trim()) : [];
}

function parseReferenceImages(value: unknown): ShotReferenceImage[] {
  if (!Array.isArray(value)) return [];
  const result: ShotReferenceImage[] = [];
  for (const item of value) {
    const raw = record(item);
    const path = optString(raw, "path");
    if (!path) continue;
    const role = optString(raw, "role");
    if (role !== "subject" && role !== "location") throw new Error("referenceImages.role 只能是 subject 或 location");
    result.push({ path, role, label: optString(raw, "label") });
    if (result.length >= 4) break;
  }
  return result;
}

function parseReferenceVideos(value: unknown): ShotReferenceVideo[] {
  if (!Array.isArray(value)) return [];
  const result: ShotReferenceVideo[] = [];
  for (const item of value) {
    const raw = record(item);
    const path = optString(raw, "path");
    if (!path) continue;
    result.push({ path, label: optString(raw, "label") });
    if (result.length >= 3) break;
  }
  return result;
}

function deepMerge(target: Args, patch: Args): Args {
  const output: Args = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    const current = output[key];
    if (current && typeof current === "object" && !Array.isArray(current) && value && typeof value === "object" && !Array.isArray(value)) {
      output[key] = deepMerge(current as Args, value as Args);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function resolveLocalPath(input: string) {
  const expanded = input.startsWith("~") ? join(homedir(), input.slice(1)) : input;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

async function downloadToCache(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`下载参考视频失败：HTTP ${response.status}`);
  const pathname = new URL(url).pathname;
  const extension = pathname.match(/\.(mp4|mov|mkv|webm|m4v)$/i)?.[1]?.toLowerCase() ?? "mp4";
  const target = join(dataDir, "cache", `${crypto.randomUUID()}.${extension}`);
  await ensureDir(join(dataDir, "cache"));
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength) throw new Error("下载的参考视频为空");
  await Bun.write(target, bytes);
  return target;
}

function compactBible(bible: StyleBible) {
  bible = normalizeStyleBible(bible);
  return {
    summary: bible.summary,
    style: bible.style,
    characters: bible.characters.map(character => ({
      id: character.id,
      name: character.name,
      descriptionZh: character.descriptionZh,
      identity: character.identity,
      wardrobe: character.wardrobe,
      refShotIds: character.refShotIds,
      refImages: character.refImages,
      stillImages: character.stillImages ?? [],
      stillPrompt: character.stillPrompt,
    })),
    locations: bible.locations.map(location => ({
      id: location.id,
      name: location.name,
      descriptionZh: location.descriptionZh,
      promptEn: location.promptEn,
      refShotIds: location.refShotIds,
      refImages: location.refImages,
      stillImages: location.stillImages ?? [],
      stillPrompt: location.stillPrompt,
    })),
    cameraGrammar: bible.cameraGrammar,
    rhythm: bible.rhythm,
    prompting: bible.prompting,
    sound: bible.sound,
  };
}

export const toolSpecs: ToolSpec[] = [
  {
    name: "update_brief",
    description: "记录/更新用户的创作需求。只传需要变更的字段。要求用户没提供的字段留空，不要编造。",
    parameters: {
      type: "object",
      properties: {
        idea: { type: "string", description: "用户想做的视频内容，尽量保留原话" },
        genre: { type: "string", description: "类型/风格，如 写实电影、广告、动画" },
        durationSeconds: { type: "number", description: "成片目标总时长（秒）" },
        aspectRatio: { type: "string", description: "画幅，如 16:9 / 9:16 / 1:1" },
        language: { type: "string", description: "对白语言" },
        mustKeep: { type: "array", items: { type: "string" }, description: "必须保留的元素" },
        avoid: { type: "array", items: { type: "string" }, description: "必须避免的元素" },
        notes: { type: "string", description: "其它约束" },
      },
    },
  },
  {
    name: "study_reference_video",
    description: "学习参考视频：本地 ffmpeg 切片 → 视觉模型逐镜头拉片 → 归纳风格圣经（定妆照、场景照、运镜、节奏）。耗时数分钟。",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", description: "本地视频绝对路径，或可下载的 http(s) 视频地址" },
        focus: { type: "string", description: "分析重点，如：运镜如何服务情绪、灯光怎么布置" },
        maxShots: { type: "number", description: "最多分析多少个镜头，默认 40" },
        force: { type: "boolean", description: "重新标注已有分析结果的镜头" },
      },
      required: ["source"],
    },
  },
  {
    name: "download_xhs_video",
    description: "下载小红书笔记视频到当前项目。需要带 xsec_token 的完整笔记 URL（或分享文案），yt-dlp 会读取浏览器登录 Cookie。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "小红书笔记链接或分享文案；推荐浏览器地址栏完整 URL，含 xsec_token" },
      },
      required: ["url"],
    },
  },
  {
    name: "read_style_bible",
    description: "读取当前项目的风格圣经。section=all 返回全部；也可只读 characters / locations / camera / style。",
    parameters: {
      type: "object",
      properties: {
        section: { type: "string", enum: ["all", "style", "characters", "locations", "camera"], description: "读取范围" },
      },
    },
  },
  {
    name: "read_learning_shots",
    description: "读取参考片的逐镜头拉片明细（时间、景别、运镜、主体、场景、描述）。用于挑选 referenceShotIds。",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "search_skills",
    description: "搜索技能库（本机累积 data/skills + 仓库公开 skills/）。规划分镜或写提示词前先搜索。公开技能默认 candidate/0.32，仅作知识参考；本机技能优先。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "需求关键词，如 对话 紧张 推镜；留空返回高置信技能" },
        kind: { type: "string", enum: ["camera", "lighting", "color", "composition", "rhythm", "prompt", "sound", "workflow", "avoid"] },
        limit: { type: "number", description: "返回条数，默认 8" },
        includeDeprecated: { type: "boolean", description: "是否包含已弃用技能" },
      },
    },
  },
  {
    name: "read_skill",
    description: "读取一条技能（本机或公开库）的完整规则、H3 prompt fragment 与可用性；公开条目只读、不记反馈。",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "extract_skills",
    description: "从当前项目的风格圣经与拉片结果重新抽取/更新全局技能（学习完成后会自动执行，这里是手动补跑）。",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "record_skill_outcome",
    description: "记录某条技能在真实生成中的效果，用于持续改进置信度与升降级。",
    parameters: {
      type: "object",
      properties: {
        skillId: { type: "string" },
        rating: { type: "string", enum: ["good", "mixed", "bad"] },
        shotId: { type: "string", description: "对应的分镜 id" },
        notes: { type: "string", description: "具体观察，例如 用力过猛/幅度刚好" },
      },
      required: ["skillId", "rating"],
    },
  },
  {
    name: "update_skill",
    description: "人工修正技能内容或状态（如根据反馈改写执行规则、停用技能）。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        patch: {
          type: "object",
          description: "可改 name/summaryZh/instruction/promptFragment/applicableWhen/avoidWhen/tags/status",
        },
      },
      required: ["id", "patch"],
    },
  },
  {
    name: "merge_skills",
    description: "把重复的技能合并到目标技能，保留证据与反馈，源技能标记为已合并。",
    parameters: {
      type: "object",
      properties: { sourceId: { type: "string" }, targetId: { type: "string" } },
      required: ["sourceId", "targetId"],
    },
  },
  {
    name: "export_skills",
    description: "把本机一条技能导出为公开条目到仓库 skills/（剥离证据图、反馈与置信度等私有字段）。用于把本地优质方法贡献回公开技能库。",
    parameters: {
      type: "object",
      properties: {
        skillId: { type: "string" },
        dryRun: { type: "boolean", description: "只预览不写入" },
        overwrite: { type: "boolean", description: "覆盖已存在的同名公开技能" },
      },
      required: ["skillId"],
    },
  },
  {
    name: "update_style_bible",
    description: "在风格圣经上做人工修正（例如合并重复角色、补充身份锚点）。结构相同的对象会深合并，数组整体替换。",
    parameters: {
      type: "object",
      properties: { patch: { type: "object", description: "要合并进风格圣经的对象" } },
      required: ["patch"],
    },
  },
  {
    name: "plan_shots",
    description: "写入/替换分镜表。每个镜头 1-15 秒整数；4 秒以下属于实验/裁剪档位。action/camera/lighting/sound 用英文写，便于直接进入 H3 提示词。",
    parameters: {
      type: "object",
      properties: {
        shots: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              durationSeconds: { type: "number", description: "1-15 的整数；低于 4 秒时生成默认按 4 秒生成后裁剪" },
              action: { type: "string", description: "英文，可观察的动作与因果" },
              dialogue: { type: "string", description: "逐字对白，没有则留空" },
              camera: { type: "string", description: "英文，运镜类型+幅度+速度+动机" },
              lighting: { type: "string", description: "英文灯光" },
              sound: { type: "string", description: "英文环境声/动作声" },
              characterIds: { type: "array", items: { type: "string" } },
              locationId: { type: "string" },
              referenceShotIds: { type: "array", items: { type: "string" }, description: "借用的参考片镜头 id，用于传递运镜/节奏" },
              skillIds: { type: "array", items: { type: "string" }, description: "本次采用的技能 id" },
              generationMode: { type: "string", enum: ["auto", "t2va", "i2va", "fl2va", "l2va", "ref2va"], description: "强制生成模式；auto 按素材自动选择" },
              firstFrame: { type: "string", description: "项目内相对路径，可选" },
              lastFrame: { type: "string", description: "项目内相对路径，可选" },
              referenceImages: { type: "array", items: { type: "object", properties: { path: { type: "string" }, role: { type: "string", enum: ["subject", "location"] }, label: { type: "string" } }, required: ["path", "role"] }, description: "Ref2VA 参考图，最多 4 张" },
              referenceVideos: { type: "array", items: { type: "object", properties: { path: { type: "string" }, label: { type: "string" } }, required: ["path"] }, description: "Ref2VA 参考视频，最多 3 段" },
            },
            required: ["action", "camera"],
          },
        },
      },
      required: ["shots"],
    },
  },
  {
    name: "build_shot_prompt",
    description: "为单个镜头生成 H3 结构化提示词并保存，不产生费用。会按参考素材自动选择 t2va/i2va/fl2va/l2va/ref2va。",
    parameters: {
      type: "object",
      properties: { shotId: { type: "string" } },
      required: ["shotId"],
    },
  },
  {
    name: "generate_still",
    description: "生成定妆照或场景照。未配置图片模型时回退为参考片关键帧。",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["character", "location"] },
        id: { type: "string", description: "风格圣经里的角色/场景 id" },
        prompt: { type: "string", description: "可选，覆盖默认提示词" },
      },
      required: ["target", "id"],
    },
  },
  {
    name: "generate_shot",
    description: "调用 MiniMax H3 生成单个镜头视频（会产生费用）。时长默认取分镜；低于 4 秒时默认按 4 秒生成后本地裁剪，只有 experimentalDuration=true 才直接请求短时长（用于验证 H3 档位）。必须先向用户展示分镜/提示词并获得明确同意，然后传 confirmed=true。",
    parameters: {
      type: "object",
      properties: {
        shotId: { type: "string" },
        confirmed: { type: "boolean", description: "用户已明确同意生成" },
        promptOverride: { type: "string", description: "可选，直接使用该提示词" },
        durationSeconds: { type: "number", description: "可选，覆盖分镜时长；1-15 秒整数" },
        experimentalDuration: { type: "boolean", description: "低于 4 秒时是否直接请求 H3；默认 false，按 4 秒生成后裁剪" },
        skillIds: { type: "array", items: { type: "string" }, description: "本次实际采用的技能 id，用于统计效果" },
      },
      required: ["shotId", "confirmed"],
    },
  },
  {
    name: "set_shot_references",
    description: "把项目内图片/视频绑定到某个分镜作为 H3 参考。images 的 role=subject/location 会自动走 Ref2VA；firstFrame/lastFrame 走 I2VA/FL2VA；videos 走 Ref2VA。用户上传的素材在 assets/uploads/。",
    parameters: {
      type: "object",
      properties: {
        shotId: { type: "string" },
        images: { type: "array", items: { type: "object", properties: { path: { type: "string" }, role: { type: "string", enum: ["subject", "location"] }, label: { type: "string" } }, required: ["path", "role"] }, description: "参考图，最多 4 张" },
        videos: { type: "array", items: { type: "object", properties: { path: { type: "string" }, label: { type: "string" } }, required: ["path"] }, description: "参考视频，最多 3 段" },
        firstFrame: { type: "string", description: "首帧图片路径；空字符串表示清除" },
        lastFrame: { type: "string", description: "尾帧图片路径；空字符串表示清除" },
        clear: { type: "boolean", description: "清空该镜头的所有参考绑定" },
      },
      required: ["shotId"],
    },
  },
  {
    name: "stitch_shots",
    description: "把已生成的分镜视频按顺序拼接成一条成片（本地 ffmpeg，不产生模型费用）。默认拼接所有已生成镜头，支持硬切与叠化。",
    parameters: {
      type: "object",
      properties: {
        shotIds: { type: "array", items: { type: "string" }, description: "按顺序拼接的镜头 id；省略则拼接所有已生成镜头" },
        outputName: { type: "string", description: "输出文件名，默认 final-项目名-总时长s.mp4" },
        transitionSeconds: { type: "number", description: "镜头间叠化秒数；0 或省略为硬切" },
        overwrite: { type: "boolean", description: "同名文件是否覆盖，默认 true" },
      },
    },
  },
  {
    name: "list_assets",
    description: "列出项目素材与分镜状态。",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "list_style_packs",
    description: "列出可复用的学习风格包（来自其它项目或历史学习）。",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "apply_style_pack",
    description: "把已有风格包套用到当前项目，并复制其中引用的参考图/片段。",
    parameters: {
      type: "object",
      properties: { packId: { type: "string" } },
      required: ["packId"],
    },
  },
  {
    name: "set_stage",
    description: "更新项目阶段：brief（需求）/ study（学习）/ plan（分镜）/ generate（生成）/ deliver（交付）。",
    parameters: {
      type: "object",
      properties: { stage: { type: "string", enum: ["brief", "study", "plan", "generate", "deliver"] } },
      required: ["stage"],
    },
  },
];

async function updateBrief(ctx: ToolContext, args: Args) {
  const brief = ctx.project.brief;
  if (args.idea !== undefined) brief.idea = reqString(args, "idea");
  if (args.genre !== undefined) brief.genre = optString(args, "genre");
  if (args.durationSeconds !== undefined) brief.durationSeconds = optNumber(args, "durationSeconds");
  if (args.aspectRatio !== undefined) brief.aspectRatio = optString(args, "aspectRatio");
  if (args.language !== undefined) brief.language = optString(args, "language");
  if (args.mustKeep !== undefined) brief.mustKeep = stringArray(args, "mustKeep");
  if (args.avoid !== undefined) brief.avoid = stringArray(args, "avoid");
  if (args.notes !== undefined) brief.notes = optString(args, "notes");
  if (ctx.project.stage === "brief" && brief.idea) ctx.project.stage = "plan";
  await ctx.save();
  return { ok: true, brief };
}

async function downloadXhsIntoProject(ctx: ToolContext, url: string) {
  const download = await downloadXhsVideo({
    url,
    signal: ctx.signal,
    onProgress: (percent, label) => ctx.emit({ type: "progress", scope: "download_xhs_video", percent, label }),
  });
  const extension = extname(download.path) || ".mp4";
  const relative = `assets/sources/xhs-${download.noteId ?? Date.now()}${extension}`;
  const target = safeJoin(projectDir(ctx.project.id), relative);
  await ensureDir(dirname(target));
  await copyInto(download.path, target);
  addAsset(ctx.project, {
    kind: "source",
    path: relative,
    label: `小红书：${download.title}`,
    meta: { sourceUrl: download.sourceUrl, originalUrl: download.originalUrl, noteId: download.noteId, duration: download.duration },
  });
  await ctx.save();
  return { ...download, absolutePath: target, relativePath: relative };
}

async function downloadXhsTool(ctx: ToolContext, args: Args) {
  const raw = reqString(args, "url");
  const url = extractUrlFromText(raw) ?? raw;
  if (!isXhsUrl(url)) throw new Error("不是小红书链接，请提供 xiaohongshu.com 或 xhslink.com 链接");
  const download = await downloadXhsIntoProject(ctx, url);
  ctx.emit({ type: "state", project: ctx.project });
  return {
    ok: true,
    title: download.title,
    noteId: download.noteId,
    localPath: download.absolutePath,
    relativePath: download.relativePath,
    durationSeconds: download.duration,
    width: download.width,
    height: download.height,
    warning: download.warning,
    next: "可以把 relativePath 传给 study_reference_video 继续学习",
  };
}

async function study(ctx: ToolContext, args: Args) {
  const rawSource = reqString(args, "source");
  const sourceUrl = extractUrlFromText(rawSource) ?? rawSource;
  let sourcePath: string;
  let sourceNote: { title: string; url: string; warning?: string } | undefined;
  if (isXhsUrl(sourceUrl)) {
    const download = await downloadXhsIntoProject(ctx, sourceUrl);
    sourcePath = download.absolutePath;
    sourceNote = { title: download.title, url: download.sourceUrl, warning: download.warning };
  } else if (/^https?:\/\//i.test(sourceUrl)) {
    sourcePath = await downloadToCache(sourceUrl, ctx.signal);
  } else {
    sourcePath = resolveLocalPath(sourceUrl);
  }
  const result = await studyReferenceVideo({
    project: ctx.project,
    settings: ctx.settings,
    sourcePath,
    focus: optString(args, "focus"),
    maxShots: optNumber(args, "maxShots"),
    force: args.force === true,
    signal: ctx.signal,
    onProgress: (percent, label) => ctx.emit({ type: "progress", scope: "study_reference_video", percent, label }),
  });
  ctx.emit({ type: "state", project: ctx.project });
  const manifest = result.manifest;
  return {
    ok: true,
    shots: manifest.shots.length,
    method: manifest.method,
    durationSeconds: manifest.duration,
    averageShotSeconds: Number((manifest.duration / Math.max(1, manifest.shots.length)).toFixed(2)),
    bible: compactBible(result.bible),
    markdown: "learning/styleBible.md",
    source: sourceNote,
    skills: result.skills,
    warning: result.warning,
    skillWarning: result.skillWarning,
  };
}

async function readBible(ctx: ToolContext, args: Args) {
  const bible = ctx.project.styleBible;
  if (!bible) return { ok: false, error: "当前项目还没有风格圣经，请先学习参考视频或套用风格包" };
  const section = optString(args, "section") ?? "all";
  if (section === "all") return { ok: true, bible: compactBible(bible), markdown: "learning/styleBible.md" };
  if (section === "style") return { ok: true, style: bible.style, prompting: bible.prompting, sound: bible.sound, summary: bible.summary };
  if (section === "characters") return { ok: true, characters: compactBible(bible).characters };
  if (section === "locations") return { ok: true, locations: compactBible(bible).locations };
  if (section === "camera") return { ok: true, cameraGrammar: bible.cameraGrammar, rhythm: bible.rhythm };
  return { ok: false, error: `未知 section：${section}` };
}

async function readShots(ctx: ToolContext) {
  const manifest = await getManifest(ctx.project);
  if (!manifest) return { ok: false, error: "还没有拉片结果，请先学习参考视频" };
  return {
    ok: true,
    source: manifest.sourceName,
    duration: manifest.duration,
    shots: manifest.shots.map(shot => ({
      id: shot.id,
      start: shot.start,
      end: shot.end,
      duration: shot.duration,
      keyframe: shot.keyframe,
      clip: shot.clip,
      ...shot.annotation,
      description: shot.annotation?.description.slice(0, 300),
      h3ShotBlock: undefined,
    })),
  };
}

async function updateBible(ctx: ToolContext, args: Args) {
  if (!ctx.project.styleBible) return { ok: false, error: "当前项目还没有风格圣经" };
  const patch = record(args.patch);
  ctx.project.styleBible = normalizeStyleBible(deepMerge(structuredClone(ctx.project.styleBible) as unknown as Args, patch) as unknown as StyleBible);
  await Bun.write(join(projectDir(ctx.project.id), "learning", "styleBible.json"), `${JSON.stringify(ctx.project.styleBible, null, 2)}\n`);
  await ctx.save();
  return { ok: true, bible: compactBible(ctx.project.styleBible) };
}

async function planShots(ctx: ToolContext, args: Args) {
  const raw = args.shots;
  if (!Array.isArray(raw) || !raw.length) throw new Error("shots 必须是非空数组");
  const bible = ctx.project.styleBible;
  const manifest = await getManifest(ctx.project);
  const plan: ShotPlan[] = raw.map((item, index) => {
    const value = record(item);
    const duration = normalizeShotDuration(value.durationSeconds ?? 5, `第 ${index + 1} 个镜头`);
    const characterIds = stringArray(value, "characterIds");
    const locationId = optString(value, "locationId");
    if (bible) {
      for (const id of characterIds) if (!bible.characters.some(character => character.id === id)) throw new Error(`角色 id 不存在：${id}`);
      if (locationId && !bible.locations.some(location => location.id === locationId)) throw new Error(`场景 id 不存在：${locationId}`);
    }
    const referenceShotIds = stringArray(value, "referenceShotIds");
    const skillIds = stringArray(value, "skillIds");
    const generationMode = optString(value, "generationMode") as ShotPlan["generationMode"];
    if (manifest) {
      for (const id of referenceShotIds) if (!manifest.shots.some(shot => shot.id === id)) throw new Error(`参考镜头 id 不存在：${id}`);
    }
    return {
      id: `s${String(index + 1).padStart(2, "0")}`,
      index: index + 1,
      title: optString(value, "title") ?? `镜头 ${index + 1}`,
      durationSeconds: duration,
      action: reqString(value, "action"),
      dialogue: optString(value, "dialogue"),
      camera: reqString(value, "camera"),
      lighting: optString(value, "lighting"),
      sound: optString(value, "sound"),
      characterIds,
      locationId,
      referenceShotIds,
      skillIds,
      generationMode,
      firstFrame: optString(value, "firstFrame"),
      lastFrame: optString(value, "lastFrame"),
      referenceImages: parseReferenceImages(value.referenceImages),
      referenceVideos: parseReferenceVideos(value.referenceVideos),
      status: "planned" as const,
      updatedAt: nowIso(),
    };
  });
  const root = projectDir(ctx.project.id);
  for (const shot of plan) {
    const paths = [
      shot.firstFrame,
      shot.lastFrame,
      ...(shot.referenceImages ?? []).map(image => image.path),
      ...(shot.referenceVideos ?? []).map(video => video.path),
    ].filter((path): path is string => Boolean(path));
    for (const path of paths) {
      if (!(await exists(safeJoin(root, path)))) throw new Error(`素材不存在：${path}`);
    }
  }
  ctx.project.plan = plan;
  if (ctx.project.stage !== "generate") ctx.project.stage = "plan";
  await ctx.save();
  const shortShots = plan.filter(shot => shot.durationSeconds < H3_SAFE_MIN_SECONDS);
  return {
    ok: true,
    totalSeconds: plan.reduce((total, shot) => total + shot.durationSeconds, 0),
    shots: plan.map(shot => ({ id: shot.id, title: shot.title, durationSeconds: shot.durationSeconds, status: shot.status })),
    ...(shortShots.length ? {
      warnings: shortShots.map(shot => `${shot.id} 时长 ${shot.durationSeconds}s 低于 H3 常规下限 ${H3_SAFE_MIN_SECONDS}s；generate_shot 默认按 ${H3_SAFE_MIN_SECONDS}s 生成后裁剪，experimentalDuration=true 才会直接请求短时长。`),
    } : {}),
  };
}

async function setShotReferences(ctx: ToolContext, args: Args) {
  const shotId = reqString(args, "shotId");
  const shot = ctx.project.plan.find(item => item.id === shotId);
  if (!shot) return { ok: false, error: `分镜不存在：${shotId}` };
  const root = projectDir(ctx.project.id);
  const clear = args.clear === true;
  const images = clear ? [] : args.images === undefined ? shot.referenceImages ?? [] : parseReferenceImages(args.images);
  const videos = clear ? [] : args.videos === undefined ? shot.referenceVideos ?? [] : parseReferenceVideos(args.videos);
  const firstFrame = clear ? undefined : args.firstFrame === undefined ? shot.firstFrame : optString(args, "firstFrame");
  const lastFrame = clear ? undefined : args.lastFrame === undefined ? shot.lastFrame : optString(args, "lastFrame");
  const paths = [firstFrame, lastFrame, ...images.map(image => image.path), ...videos.map(video => video.path)].filter((path): path is string => Boolean(path));
  for (const path of paths) {
    if (!(await exists(safeJoin(root, path)))) throw new Error(`素材不存在：${path}`);
  }
  const changed = clear || args.images !== undefined || args.videos !== undefined || args.firstFrame !== undefined || args.lastFrame !== undefined;
  shot.referenceImages = images;
  shot.referenceVideos = videos;
  shot.firstFrame = firstFrame;
  shot.lastFrame = lastFrame;
  if (changed) {
    shot.status = "planned";
    shot.video = undefined;
    shot.videoId = undefined;
    shot.prompt = undefined;
    shot.promptMode = undefined;
    shot.error = undefined;
    // 参考素材变了，让 prepareReferences 按新素材重新选模式，而不是沿用旧的强制模式。
    shot.generationMode = "auto";
  }
  shot.updatedAt = nowIso();
  await ctx.save();
  return {
    ok: true,
    shotId,
    references: {
      images,
      videos,
      firstFrame,
      lastFrame,
    },
  };
}

async function buildPrompt(ctx: ToolContext, args: Args) {
  const shotId = reqString(args, "shotId");
  const shot = ctx.project.plan.find(item => item.id === shotId);
  if (!shot) return { ok: false, error: `分镜不存在：${shotId}` };
  const references = await prepareReferences(ctx.project, shot);
  const composed = await composeShotPrompt({
    shot,
    bible: ctx.project.styleBible,
    mode: references.mode,
    duration: shot.durationSeconds,
    aspectRatio: ctx.project.brief.aspectRatio ?? ctx.settings.video.aspectRatio,
    references,
    signal: ctx.signal,
  });
  shot.prompt = composed.prompt;
  shot.promptMode = references.mode as PromptMode;
  shot.status = "promptReady";
  shot.updatedAt = nowIso();
  await ctx.save();
  return {
    ok: true,
    shotId,
    mode: references.mode,
    source: composed.source,
    problems: composed.problems,
    prompt: composed.prompt,
    references: { firstFrame: references.firstFrame, images: references.images.map(image => image.path), videos: references.videos.map(video => video.path) },
  };
}

async function generateShotTool(ctx: ToolContext, args: Args) {
  const shotId = reqString(args, "shotId");
  if (args.confirmed !== true) {
    return { ok: false, error: "生成视频会产生费用。请先向用户展示分镜和提示词，取得明确同意后，再以 confirmed=true 调用。" };
  }
  const shot = ctx.project.plan.find(item => item.id === shotId);
  const result = await generateShot({
    project: ctx.project,
    settings: ctx.settings,
    shotId,
    promptOverride: optString(args, "promptOverride"),
    durationSeconds: optNumber(args, "durationSeconds"),
    experimentalDuration: args.experimentalDuration === true,
    skillIds: args.skillIds === undefined ? shot?.skillIds : stringArray(args, "skillIds"),
    signal: ctx.signal,
    onProgress: (percent, label) => ctx.emit({ type: "progress", scope: "generate_shot", percent, label }),
  });
  ctx.emit({ type: "state", project: ctx.project });
  return { ok: true, ...result };
}

async function stitchShotsTool(ctx: ToolContext, args: Args) {
  const result = await stitchShots({
    project: ctx.project,
    shotIds: stringArray(args, "shotIds"),
    outputName: optString(args, "outputName"),
    transitionSeconds: optNumber(args, "transitionSeconds"),
    overwrite: args.overwrite !== false,
    signal: ctx.signal,
    onProgress: (percent, label) => ctx.emit({ type: "progress", scope: "stitch_shots", percent, label }),
  });
  ctx.emit({ type: "state", project: ctx.project });
  return result;
}

async function generateStillTool(ctx: ToolContext, args: Args) {
  const target = reqString(args, "target");
  if (target !== "character" && target !== "location") throw new Error("target 只能是 character 或 location");
  const result = await generateStill({
    project: ctx.project,
    settings: ctx.settings,
    target,
    id: reqString(args, "id"),
    promptOverride: optString(args, "prompt"),
    signal: ctx.signal,
  });
  ctx.emit({ type: "state", project: ctx.project });
  return { ok: true, ...result };
}

async function listAssets(ctx: ToolContext) {
  return {
    ok: true,
    stage: ctx.project.stage,
    assets: ctx.project.assets.slice(-40),
    plan: ctx.project.plan.map(shot => ({
      id: shot.id,
      title: shot.title,
      status: shot.status,
      video: shot.video,
      promptMode: shot.promptMode,
      firstFrame: shot.firstFrame,
      lastFrame: shot.lastFrame,
      referenceImages: shot.referenceImages ?? [],
      referenceVideos: shot.referenceVideos ?? [],
    })),
    files: { project: `projects/${ctx.project.id}/project.json`, bible: ctx.project.styleBible ? "learning/styleBible.md" : undefined },
  };
}

async function applyPack(ctx: ToolContext, args: Args) {
  const packId = reqString(args, "packId");
  const { bible, copied } = await applyStylePack(ctx.project, packId);
  await ctx.save();
  return {
    ok: true,
    packId,
    copiedFiles: copied,
    bible: compactBible(bible),
    note: "已套用风格包；原分镜不会被自动覆盖，需要重新 plan_shots。",
  };
}

async function setStage(ctx: ToolContext, args: Args) {
  const stage = reqString(args, "stage") as Stage;
  if (!["brief", "study", "plan", "generate", "deliver"].includes(stage)) throw new Error(`未知阶段：${stage}`);
  ctx.project.stage = stage;
  await ctx.save();
  return { ok: true, stage };
}

async function searchSkillsTool(_ctx: ToolContext, args: Args) {
  const kind = optString(args, "kind") as SkillKind | undefined;
  const results = await searchSkills(optString(args, "query") ?? "", {
    kind,
    limit: optNumber(args, "limit"),
    includeDeprecated: args.includeDeprecated === true,
  });
  return { ok: true, skills: results.map(({ skill, score }) => ({ ...skillToSummary(skill), score })) };
}

async function readSkillTool(_ctx: ToolContext, args: Args) {
  const { skill, source, markdownPath } = await readSkillResolved(reqString(args, "id"));
  return { ok: true, skill: skillToSummary(skill), source, markdownPath };
}

async function exportSkillsTool(_ctx: ToolContext, args: Args) {
  const result = await exportPublicSkill(reqString(args, "skillId"), {
    dryRun: args.dryRun === true,
    overwrite: args.overwrite === true,
  });
  return result;
}

async function extractSkillsTool(ctx: ToolContext) {
  const manifest = await getManifest(ctx.project);
  if (!manifest) return { ok: false, error: "还没有拉片结果，请先学习参考视频" };
  if (!ctx.project.styleBible) return { ok: false, error: "还没有风格圣经" };
  const result = await extractSkillsFromStudy({
    project: ctx.project,
    manifest,
    bible: ctx.project.styleBible,
    signal: ctx.signal,
    onProgress: (percent, label) => ctx.emit({ type: "progress", scope: "extract_skills", percent, label }),
  });
  ctx.project.learning.skills = { created: result.created.length, merged: result.merged.length };
  await ctx.save();
  ctx.emit({ type: "state", project: ctx.project });
  return { ok: true, ...result };
}

async function recordSkillOutcomeTool(ctx: ToolContext, args: Args) {
  const rating = reqString(args, "rating");
  if (!["good", "mixed", "bad"].includes(rating)) throw new Error("rating 只能是 good/mixed/bad");
  const skill = await recordSkillOutcome({
    skillId: reqString(args, "skillId"),
    rating: rating as "good" | "mixed" | "bad",
    projectId: ctx.project.id,
    shotId: optString(args, "shotId"),
    notes: optString(args, "notes"),
  });
  return { ok: true, skill: skillToSummary(skill) };
}

async function updateSkillTool(_ctx: ToolContext, args: Args) {
  const skill = await updateSkill(reqString(args, "id"), record(args.patch));
  return { ok: true, skill: skillToSummary(skill) };
}

async function mergeSkillsTool(_ctx: ToolContext, args: Args) {
  const merged = await mergeSkills(reqString(args, "sourceId"), reqString(args, "targetId"));
  return { ok: true, target: skillToSummary(merged.target), source: skillToSummary(merged.source) };
}

const handlers: Record<string, (ctx: ToolContext, args: Args) => Promise<unknown>> = {
  update_brief: updateBrief,
  download_xhs_video: downloadXhsTool,
  study_reference_video: study,
  read_style_bible: readBible,
  read_learning_shots: readShots,
  search_skills: searchSkillsTool,
  read_skill: readSkillTool,
  extract_skills: extractSkillsTool,
  record_skill_outcome: recordSkillOutcomeTool,
  update_skill: updateSkillTool,
  merge_skills: mergeSkillsTool,
  export_skills: exportSkillsTool,
  update_style_bible: updateBible,
  plan_shots: planShots,
  set_shot_references: setShotReferences,
  build_shot_prompt: buildPrompt,
  generate_shot: generateShotTool,
  generate_still: generateStillTool,
  stitch_shots: stitchShotsTool,
  list_assets: listAssets,
  list_style_packs: async (ctx, args) => ({ ok: true, packs: await listStylePacks(), note: "可用 apply_style_pack 套用" }),
  apply_style_pack: applyPack,
  set_stage: setStage,
};

export async function executeTool(name: string, rawArgs: string, ctx: ToolContext) {
  const handler = handlers[name];
  if (!handler) throw new Error(`未知工具：${name}`);
  let args: Args = {};
  if (rawArgs.trim()) {
    try {
      args = record(JSON.parse(rawArgs));
    } catch {
      throw new Error(`工具 ${name} 参数不是合法 JSON：${rawArgs.slice(0, 200)}`);
    }
  }
  return handler(ctx, args);
}


