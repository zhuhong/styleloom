import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { dataDir } from "../config";
import type { Settings } from "../config";
import type { AgentEvent, PromptMode, Project, ShotPlan, ShotReferenceImage, ShotReferenceVideo, SkillKind, Stage, StyleBible } from "../types";
import type { ToolSpec } from "../providers/llm";
import { copyInto, ensureDir, exists, nowIso, safeJoin, stamp } from "../util/fs";
import { addAsset, deleteProject, getManifest, projectDir, renameProject } from "../store/projects";
import { applyStylePack, listStylePacks } from "../store/library";
import { studyReferenceVideo } from "../learn/study";
import { describeImage } from "../learn/describeImage";
import { resumeShot } from "../generate/shot";
import { activeJobForShot, clearJobsForProject, listJobs, startRenderJob } from "../generate/jobs";
import { generateStill } from "../generate/still";
import { editImageWithModel } from "../providers/image";
import { stitchShots } from "../generate/stitch";
import { H3_SAFE_MIN_SECONDS, normalizeShotDuration } from "../util/duration";
import { composeShotPrompt, prepareReferences } from "../generate/prompt";
import { downloadXhsVideo, extractUrlFromText, isXhsUrl } from "../providers/download/xhs";
import { exportPublicSkill, findNearDuplicatePairs, listSkills, mergeSkills, readSkillResolved, recordSkillOutcome, searchSkills, skillToSummary, updateSkill } from "../store/skills";
import { extractSkillsFromStudy } from "../learn/skills";
import { normalizeStyleBible } from "../learn/bible";

export type ToolContext = {
  project: Project;
  settings: Settings;
  emit: (event: AgentEvent) => void;
  signal: AbortSignal;
  save: () => Promise<void>;
  /** delete_project 成功后置 true；loop 不再写回盘，也不再调后续工具。 */
  meta: { deleted: boolean };
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
    name: "describe_image",
    description: "用视觉模型读一张项目内图片（用户上传的参考图、定妆照、场景照），返回结构化构图分析：主体位置、景别、视角、构图法、光线、色调、焦段，以及可直接用于 t2v 的英文画面段落。用户上传图片并要求学构图、按图生成、看图改提示词时必须先调用它，不要反问用户图里画了什么。单张约一次视觉模型调用；同一张图同样 focus 的重复调用走本地缓存不重复计费。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "项目内相对路径，如 assets/uploads/xxx.png。省略时取最近一张图片素材" },
        paths: { type: "array", items: { type: "string" }, description: "可选，一次最多 3 张；与 path 二选一，同时给出会合并" },
        focus: { type: "string", description: "可选，分析重点，如 构图落点 / 光线方向 / 色调 / 焦段" },
        refresh: { type: "boolean", description: "忽略缓存重新分析，默认 false" },
      },
    },
  },
  {
    name: "search_skills",
    description: "搜索技能库（本机累积 data/skills + 仓库公开 skills/）。规划分镜或写提示词前先搜索；生成定妆照/场景照前可用 kind=still 或 surface=still 找出图技能。公开技能默认 candidate/0.32，仅作知识参考；本机技能优先。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "需求关键词，如 对话 紧张 推镜 / 定妆照 全身；留空返回高置信技能" },
        kind: { type: "string", enum: ["camera", "lighting", "color", "composition", "rhythm", "prompt", "sound", "workflow", "avoid", "still"] },
        surface: { type: "string", enum: ["video", "still"], description: "按作用面过滤：video=视频提示词，still=定妆照/场景照" },
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
        shotId: { type: "string", description: "对应的分镜 id；出图技能写 still:<target>:<id>，例如 still:character:c1" },
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
    name: "review_skill_duplicates",
    description: "扫描本机技能库中的近义重复对，返回合并建议（不自动合并）。库膨胀或学习后出现相似运镜/灯光技能时先用这个。",
    parameters: {
      type: "object",
      properties: {
        threshold: { type: "number", description: "相似度阈值，默认 0.38" },
        limit: { type: "number", description: "最多返回几对，默认 12" },
      },
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
    description: "生成定妆照或场景照。会自动带上「出图技能」（kind=still，或 appliesTo 含 still）：默认按目标检索并注入想要的提示词片段，也可用 skillIds 指定。本地 GPU（直连/SSH）免费，远程图片接口（默认 icompify qwen-image-2.1，可用 model 切到 minimax-h3-image；主模型不可用时自动退到 image.fallbackModel）按张计费；都不可用时回退为参考片关键帧。",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["character", "location"] },
        id: { type: "string", description: "风格圣经里的角色/场景 id" },
        prompt: { type: "string", description: "可选，覆盖默认提示词（技能片段仍会追加）" },
        skillIds: { type: "array", items: { type: "string" }, description: "可选，指定本次采用的出图技能 id；留空按定妆照/场景照自动检索" },
        model: { type: "string", description: "可选，覆盖出图模型（icompify 可选 qwen-image-2.1 / minimax-h3-image）；不传用 image.model，失败自动退到 image.fallbackModel" },
        ratio: { type: "string", enum: ["1:1", "9:16", "16:9", "4:3", "3:4", "2:3", "3:2", "21:9"], description: "可选，画幅；用户说正方形/横版时一定要传（不传沿用项目 brief 的画幅，参考片是竖屏时就会一直是竖屏）" },
        size: { type: "string", description: "可选，输出尺寸（宽x高 或 1K/2K）；不传用 image.size" },
      },
      required: ["target", "id"],
    },
  },
  {
    name: "edit_image",
    description: "改图：拿项目内已有的一张图片当原图，按修改要求局部修改（换色/换装/加删道具/改姿态），原图保留、结果另存为新的素材。icompify 与本地 GPU 支持；OpenRouter 没有编辑接口会直接报错。按张计费，必须 confirmed=true。确认流程同上：先用 confirmed=false 弹确认卡片，用户点击后系统会发来确认消息，再传 confirmed=true。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "原图的项目内相对路径（如 assets/stills/character-c1-xxx.png，先用 list_assets 确认）" },
        prompt: { type: "string", description: "修改要求，英文更稳；只描述要改的部分，并显式要求其余保持不变" },
        confirmed: { type: "boolean", description: "用户已明确同意（会产生费用）" },
        model: { type: "string", description: "可选，覆盖改图模型；不传用 image.editModel（默认 qwen-image-2.1），失败自动退到 image.fallbackModel" },
        size: { type: "string", description: "可选，输出尺寸（宽x高 或 1K/2K）；不传沿用设置" },
        ratio: { type: "string", enum: ["1:1", "9:16", "16:9", "4:3", "3:4", "2:3", "3:2", "21:9"], description: "可选，画幅；不传沿用项目 brief（改图建议与原图一致）" },
        label: { type: "string", description: "可选，素材栏显示的名字" },
      },
      required: ["path", "prompt", "confirmed"],
    },
  },
  {
    name: "generate_shot",
    description: "调用视频后端生成单个镜头视频：icompify 按次计费，本地 GPU 网关免费但占用显存。时长默认取分镜；低于 4 秒时默认按 4 秒生成后本地裁剪，只有 experimentalDuration=true 才直接请求短时长（用于验证 H3 档位）。video.provider=local 时不支持尾帧、参考视频，ref2va 只用第 1 张参考图。确认流程（强制）：凡是要提交视频，都必须先以 confirmed=false 调用本工具来弹「提交/取消」确认卡片；confirmed=false 不产生费用、不算提交，禁止只用文字问用户要不要提交。用户点击「提交」后会自动发来确认消息，此时再传 confirmed=true。",
    parameters: {
      type: "object",
      properties: {
        shotId: { type: "string" },
        confirmed: { type: "boolean", description: "false = 只申请用户确认（前端弹确认卡片，不产生费用）；true = 用户已点击「提交」后真正开始生成" },
        promptOverride: { type: "string", description: "可选，直接使用该提示词" },
        durationSeconds: { type: "number", description: "可选，覆盖分镜时长；1-15 秒整数" },
        experimentalDuration: { type: "boolean", description: "低于 4 秒时是否直接请求 H3；默认 false，按 4 秒生成后裁剪" },
        skillIds: { type: "array", items: { type: "string" }, description: "本次实际采用的技能 id，用于统计效果" },
        force: { type: "boolean", description: "该镜头已有未完成任务时仍要新建（会二次计费）；默认 false，应先试 resume_shot" },
      },
      required: ["shotId", "confirmed"],
    },
  },
  {
    name: "resume_shot",
    description: "接回一个已提交但本地放弃等待的 H3 任务（不重新生成、不重复计费）。probeOnly=true 只查一次平台状态。用于 resume 排队超时或服务重启后遗留的任务。",
    parameters: {
      type: "object",
      properties: {
        shotId: { type: "string" },
        probeOnly: { type: "boolean", description: "只查询平台状态并回报，不下载、不等待" },
      },
      required: ["shotId"],
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
  {
    name: "rename_project",
    description: "重命名当前项目（只改标题，不改项目 id）。用户说改名/换标题时使用。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "新的项目标题" },
      },
      required: ["title"],
    },
  },
  {
    name: "delete_project",
    description: "删除当前项目及其本地素材、对话记录，不可恢复。必须先向用户确认后果，再传 confirmed=true。有进行中的渲染任务时会拒绝。",
    parameters: {
      type: "object",
      properties: {
        confirmed: { type: "boolean", description: "用户已明确同意删除当前项目" },
      },
      required: ["confirmed"],
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
  // ctx.save() 写完盘就会广播 state，不需要再手动 emit。
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
    skillIds: shot.skillIds,
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
    skillIds: composed.skillIds,
    prompt: composed.prompt,
    references: { firstFrame: references.firstFrame, images: references.images.map(image => image.path), videos: references.videos.map(video => video.path) },
  };
}

async function generateShotTool(ctx: ToolContext, args: Args) {
  const shotId = reqString(args, "shotId");
  if (args.confirmed !== true) {
    // 不是错误：前端据此渲染「提交/取消」确认卡片，用户点击后自动发出确认消息。
    const pendingShot = ctx.project.plan.find(item => item.id === shotId);
    return {
      ok: true,
      requiresConfirmation: true,
      shotId,
      title: pendingShot?.title,
      durationSeconds: optNumber(args, "durationSeconds") ?? pendingShot?.durationSeconds,
      promptOverride: optString(args, "promptOverride"),
      experimentalDuration: args.experimentalDuration === true,
      skillIds: args.skillIds === undefined ? pendingShot?.skillIds : stringArray(args, "skillIds"),
      // force 必须在确认前就传：已有未完成任务时重提会二次计费，卡片要如实标注。
      force: args.force === true,
      note: "尚未提交、未产生费用。前端会显示确认卡片；用户点击「提交」后会自动发来确认消息，届时用 confirmed=true 调用本工具。",
    };
  }
  const shot = ctx.project.plan.find(item => item.id === shotId);
  // 内存里已有 running job（即便盘上 videoId 被旧快照抹掉）也不允许再提交。
  const live = activeJobForShot(ctx.project.id, shotId);
  if (live && (live.status === "running" || live.status === "pending") && args.force !== true) {
    return {
      ok: false,
      error: `镜头 ${shotId} 已有后台任务在跑（${live.label}${live.videoId ? `，video_id=${live.videoId}` : ""}）。请等右侧渲染面板结束，或用 resume_shot；不要重新 generate_shot。`,
      jobId: live.id,
      videoId: live.videoId,
      status: live.status,
    };
  }
  // 已有提交过但未完成的任务：直接新建会二次计费，先让调用方明确处理。
  if (shot?.videoId && shot.status !== "done" && args.force !== true) {
    return {
      ok: false,
      error: `镜头 ${shotId} 已有未完成任务 ${shot.videoId}（状态 ${shot.status}）。重新生成会二次计费，请先用 resume_shot 恢复；确实要丢弃旧任务并重做时才传 force=true。`,
      videoId: shot.videoId,
      status: shot.status,
    };
  }
  // 后台执行：立刻返回，让对话继续；进度走右侧面板，不占气泡，也不随浏览器断开而中断。
  const job = startRenderJob({
    projectId: ctx.project.id,
    shotId,
    promptOverride: optString(args, "promptOverride"),
    durationSeconds: optNumber(args, "durationSeconds"),
    experimentalDuration: args.experimentalDuration === true,
    skillIds: args.skillIds === undefined ? shot?.skillIds : stringArray(args, "skillIds"),
  });
  return {
    ok: true,
    async: true,
    jobId: job.id,
    shotId,
    status: job.status,
    note: "已在后台开始渲染。进度显示在右侧「渲染」面板；本轮对话可以直接结束，也可以继续聊别的事。完成后用 list_assets 查看，失败或超时用 resume_shot 接回。",
  };
}

async function resumeShotTool(ctx: ToolContext, args: Args) {
  const result = await resumeShot({
    project: ctx.project,
    settings: ctx.settings,
    shotId: reqString(args, "shotId"),
    signal: ctx.signal,
    onProgress: (percent, label) => ctx.emit({ type: "progress", scope: "resume_shot", percent, label }),
    probeOnly: args.probeOnly === true,
  });
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
    skillIds: Array.isArray(args.skillIds) ? args.skillIds.map(value => String(value)).filter(Boolean) : undefined,
    model: optString(args, "model"),
    ratio: optString(args, "ratio"),
    size: optString(args, "size"),
    signal: ctx.signal,
    onProgress: (percent, label) => ctx.emit({ type: "progress", scope: "generate_still", percent, label }),
  });
  return { ok: true, ...result };
}

async function editImageTool(ctx: ToolContext, args: Args) {
  if (args.confirmed !== true) {
    throw new Error("改图会真实计费，必须先向用户展示要改的图和修改要求，得到明确同意后传 confirmed=true");
  }
  const relative = reqString(args, "path");
  const prompt = reqString(args, "prompt");
  const root = projectDir(ctx.project.id);
  const source = safeJoin(root, relative);
  if (!(await exists(source))) throw new Error(`原图不存在：${relative}（先用 list_assets 确认路径）`);
  const result = await editImageWithModel({
    source,
    prompt,
    model: optString(args, "model"),
    size: optString(args, "size"),
    ratio: optString(args, "ratio") || ctx.project.brief.aspectRatio || "1:1",
    signal: ctx.signal,
    onProgress: (percent, label) => ctx.emit({ type: "progress", scope: "edit_image", percent, label }),
  });
  const extension = result.mimeType.includes("png") ? ".png" : result.mimeType.includes("webp") ? ".webp" : ".jpg";
  const target = `assets/edits/edit-${stamp()}${extension}`;
  await ensureDir(join(root, "assets", "edits"));
  await writeFile(join(root, target), result.bytes);
  addAsset(ctx.project, {
    kind: "still",
    path: target,
    label: optString(args, "label") || `改图 ${relative.split("/").pop() || ""}`,
    meta: { editedFrom: relative, prompt, model: result.model, backend: result.backend, seconds: result.seconds },
  });
  await ctx.save();
  return {
    ok: true,
    path: target,
    source: relative,
    ratio: optString(args, "ratio") || ctx.project.brief.aspectRatio || "1:1",
    model: result.model,
    backend: result.backend,
    seconds: result.seconds,
    note: "已另存为新素材，原图未被覆盖。",
  };
}

const IMAGE_PATH_RE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;

async function describeImageTool(ctx: ToolContext, args: Args) {
  const explicit = [...(optString(args, "path") ? [optString(args, "path")!] : []), ...stringArray(args, "paths")];
  let targets = [...new Set(explicit)];
  let autoPicked = false;
  if (!targets.length) {
    const imageAssets = ctx.project.assets.filter(asset => IMAGE_PATH_RE.test(asset.path));
    const latest = imageAssets[imageAssets.length - 1];
    if (!latest) {
      return { ok: false, error: "项目里还没有图片素材。请让用户先在聊天框上传图片，或先用 generate_still 出图。" };
    }
    targets = [latest.path];
    autoPicked = true;
  }
  if (targets.length > 3) throw new Error("一次最多分析 3 张图片，请分批调用");

  const projectId = ctx.project.id;
  const url = (path: string) => `/files/${encodeURIComponent(projectId)}/${path.split("/").map(encodeURIComponent).join("/")}`;
  const images = [];
  for (const [index, path] of targets.entries()) {
    ctx.emit({ type: "progress", scope: "describe_image", percent: (index / targets.length) * 100, label: `读图 ${index + 1}/${targets.length}` });
    const analysis = await describeImage({
      project: ctx.project,
      settings: ctx.settings,
      path,
      focus: optString(args, "focus"),
      refresh: args.refresh === true,
      signal: ctx.signal,
    });
    images.push({
      ...analysis,
      url: url(path),
      markdown: `![构图参考](${url(path)})`,
    });
  }
  return {
    ok: true,
    projectId,
    images,
    autoPicked,
    note: autoPicked ? "未指定 path，已自动取最近一张图片素材；如需别的图请显式传 path。" : undefined,
    nextStep: "把 images[].t2vPrompt 当作画面段写进 t2v 分镜；构图落点、景别、视角来自 images[].composition/shotSize/cameraAngle，不要改写这些结论。",
  };
}

async function listAssets(ctx: ToolContext) {
  const projectId = ctx.project.id;
  // 把项目内相对路径补成浏览器可用的 /files 绝对 URL，模型直接 `![](url)` 就能内联展示。
  const url = (path?: string | null) => (path ? `/files/${encodeURIComponent(projectId)}/${path.split("/").map(encodeURIComponent).join("/")}` : "");
  const jobs = listJobs(projectId).map(job => ({
    id: job.id,
    shotId: job.shotId,
    status: job.status,
    percent: job.percent,
    label: job.label,
    videoId: job.videoId,
    error: job.error,
  }));
  return {
    ok: true,
    stage: ctx.project.stage,
    projectId,
    // media 是可直接内联的 Markdown 片段；直接复核这里的路径最省事。
    media: ctx.project.assets.slice(-40).map(asset => ({
      kind: asset.kind,
      path: asset.path,
      label: asset.label,
      url: url(asset.path),
      markdown: `![${asset.label || asset.path}](${url(asset.path)})`,
    })),
    assets: ctx.project.assets.slice(-40).map(asset => ({ ...asset, url: url(asset.path) })),
    plan: ctx.project.plan.map(shot => ({
      id: shot.id,
      title: shot.title,
      status: shot.status,
      video: shot.video,
      videoUrl: url(shot.video),
      videoId: shot.videoId,
      promptMode: shot.promptMode,
      firstFrame: shot.firstFrame,
      lastFrame: shot.lastFrame,
      referenceImages: shot.referenceImages ?? [],
      referenceVideos: shot.referenceVideos ?? [],
      error: shot.error,
    })),
    // 后台渲染以 jobs 为准；plan.videoId 可能因旧快照写盘短暂缺失，切勿仅凭 plan 判断「无平台任务」。
    jobs,
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

async function renameProjectTool(ctx: ToolContext, args: Args) {
  const title = reqString(args, "title");
  const updated = await renameProject(ctx.project.id, title);
  ctx.project.title = updated.title;
  ctx.project.updatedAt = updated.updatedAt;
  ctx.emit({ type: "state", project: ctx.project });
  return {
    ok: true,
    id: ctx.project.id,
    title: ctx.project.title,
    note: "项目已重命名；左侧项目列表会同步更新。",
  };
}

async function deleteProjectTool(ctx: ToolContext, args: Args) {
  if (args.confirmed !== true) {
    return {
      ok: false,
      error: "删除不可恢复。请先向用户说明会删掉本地素材与对话，取得明确同意后，再以 confirmed=true 调用。",
    };
  }
  if (listJobs(ctx.project.id).some(job => job.status === "running")) {
    return { ok: false, error: "该项目有渲染任务进行中，请等结束后再删除，或先在右侧渲染面板确认任务状态。" };
  }
  const id = ctx.project.id;
  const title = ctx.project.title;
  clearJobsForProject(id);
  await deleteProject(id);
  ctx.meta.deleted = true;
  ctx.emit({ type: "project_deleted", id });
  return {
    ok: true,
    id,
    title,
    note: "项目已删除。请告知用户可在左侧新建或选择其它项目；本轮不要再调用依赖本项目的工具。",
  };
}

async function searchSkillsTool(_ctx: ToolContext, args: Args) {
  const kind = optString(args, "kind") as SkillKind | undefined;
  const surface = optString(args, "surface");
  const results = await searchSkills(optString(args, "query") ?? "", {
    kind,
    surface: surface === "video" || surface === "still" ? surface : undefined,
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

async function reviewSkillDuplicatesTool(_ctx: ToolContext, args: Args) {
  const threshold = typeof args.threshold === "number" ? args.threshold : 0.38;
  const limit = Math.min(30, Math.max(1, typeof args.limit === "number" ? Math.floor(args.limit) : 12));
  const pairs = findNearDuplicatePairs(await listSkills(true), threshold).slice(0, limit);
  return {
    ok: true,
    count: pairs.length,
    pairs: pairs.map(pair => ({
      score: pair.score,
      left: skillToSummary(pair.left),
      right: skillToSummary(pair.right),
      suggestion: `可考虑 merge_skills(sourceId=${pair.right.id}, targetId=${pair.left.id})，保留证据更多/置信更高的一侧做 target`,
    })),
  };
}

const handlers: Record<string, (ctx: ToolContext, args: Args) => Promise<unknown>> = {
  update_brief: updateBrief,
  download_xhs_video: downloadXhsTool,
  study_reference_video: study,
  read_style_bible: readBible,
  read_learning_shots: readShots,
  describe_image: describeImageTool,
  search_skills: searchSkillsTool,
  read_skill: readSkillTool,
  extract_skills: extractSkillsTool,
  record_skill_outcome: recordSkillOutcomeTool,
  update_skill: updateSkillTool,
  merge_skills: mergeSkillsTool,
  export_skills: exportSkillsTool,
  review_skill_duplicates: reviewSkillDuplicatesTool,
  update_style_bible: updateBible,
  plan_shots: planShots,
  set_shot_references: setShotReferences,
  build_shot_prompt: buildPrompt,
  generate_shot: generateShotTool,
  resume_shot: resumeShotTool,
  generate_still: generateStillTool,
  edit_image: editImageTool,
  stitch_shots: stitchShotsTool,
  list_assets: listAssets,
  list_style_packs: async (ctx, args) => ({ ok: true, packs: await listStylePacks(), note: "可用 apply_style_pack 套用" }),
  apply_style_pack: applyPack,
  set_stage: setStage,
  rename_project: renameProjectTool,
  delete_project: deleteProjectTool,
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


