import { basename, extname, join } from "node:path";
import { writeFile } from "node:fs/promises";
import { dataDir, loadSettings, maskSettings, preserveSecrets, saveSettings, settingsPath, webDir, defaultSettings } from "./config";
import { ensureDir, exists, readJsonIfExists, safeJoin, slugify, stamp } from "./util/fs";
import { addAsset, createProject, deleteProject, getManifest, getProject, listProjects, mutateProject, projectDir, readSession, reconcileProjectAssets, renameProject, saveProject } from "./store/projects";
import { listStylePacks } from "./store/library";
import { getSkill, listSkills, recordSkillOutcome, recordSkillOutcomesForShot, searchSkills, skillEvidenceFile, skillToMarkdown, skillToSummary, updateSkill } from "./store/skills";
import type { ChatAttachment, Project, SkillKind } from "./types";
import { runAgentTurn } from "./agent/loop";
import { flushRenderWakeQueue, notifyRenderJobTerminal } from "./agent/renderWake";
import { endAgentTurn, isAgentTurnActive, tryBeginAgentTurn } from "./agent/turnLock";
import type { LlmMessage } from "./providers/llm";
import { runProcess } from "./util/ffmpeg";
import { clearJobsForProject, flushLiveVideoIds, listJobs, reconcileStaleJobs, setRenderTerminalHook, startResumeJob, subscribeJobs, subscribeProjectAgentEvents } from "./generate/jobs";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const imageExtensionByMime: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "image/bmp": ".bmp",
};

/**
 * 拒绝内网/本机地址，避免「拖一个链接进来」变成打内网的跳板。
 * ACT: 只做字面量判断（hostname 里的 IP 或 localhost 后缀），不解析 DNS，
 * 也不防 DNS rebinding；自行部署到不可信网络时请再加出网代理或白名单。
 */
function isBlockedUploadHost(hostname: string) {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return true;
  if (host.includes(":")) return true; // IPv6 字面量一律拒绝
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

function assertRemoteImageUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`不是合法链接：${raw.slice(0, 120)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`只支持 http(s) 链接：${raw.slice(0, 120)}`);
  if (isBlockedUploadHost(url.hostname)) throw new Error(`拒绝访问内网地址：${url.hostname}`);
  return url;
}

/**
 * 下载一个远端图片链接（从其它应用拖进来的图片地址）。
 * 手动跟随最多 3 次跳转并在每一跳重新校验主机，避免 302 到内网。
 */
async function downloadRemoteImage(raw: string) {
  let url = assertRemoteImageUrl(raw);
  for (let hop = 0; hop <= 3; hop += 1) {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
      headers: { Accept: "image/*" },
    }).catch(error => {
      throw new Error(`下载失败：${(error as Error).message}`);
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`跳转缺少 Location：${url.hostname}`);
      if (hop === 3) throw new Error("跳转次数过多");
      url = assertRemoteImageUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）：${url.hostname}${url.pathname.slice(0, 60)}`);
    const mimeType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (mimeType === "image/svg+xml") throw new Error("不支持 SVG，请改用 JPG/PNG/WebP");
    if (!mimeType.startsWith("image/")) throw new Error(`链接不是图片（${mimeType || "未知类型"}）`);
    const extension = imageExtensionByMime[mimeType];
    if (!extension) throw new Error(`不支持的图片类型：${mimeType}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const maxBytes = 20 * 1024 * 1024;
    if (!bytes.byteLength) throw new Error("链接返回空内容");
    if (bytes.byteLength > maxBytes) throw new Error(`图片超过上限 ${maxBytes / 1024 / 1024}MB`);
    const name = basename(url.pathname) || "dropped";
    return { bytes, mimeType, extension, name, sourceUrl: url.toString() };
  }
  throw new Error("跳转次数过多");
}

function historyMessages(messages: LlmMessage[]) {
  return messages
    .filter(message => (message.role === "user" || message.role === "assistant")
      && ((typeof message.content === "string" && message.content.trim()) || message.attachments?.length))
    // 渲染完成自动唤醒的用户消息、确认卡片代发的用户消息只给模型看，不回放到聊天气泡。
    .filter(message => !(message.role === "user"
      && typeof message.content === "string"
      && (message.content.startsWith("[系统通知]") || message.content.startsWith("[确认卡片]"))))
    .map(message => ({
      role: message.role,
      content: typeof message.content === "string" ? message.content : "",
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    }));
}

function normalizeChatAttachments(value: unknown, project: Project): ChatAttachment[] {
  if (!Array.isArray(value)) return [];
  const uploads = new Map(project.assets.filter(asset => asset.kind === "upload").map(asset => [asset.path, asset]));
  const result: ChatAttachment[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const path = (item as { path?: unknown }).path;
    if (typeof path !== "string") continue;
    const asset = uploads.get(path);
    if (!asset) continue;
    const kind: ChatAttachment["kind"] = /\.(mp4|mov|webm|m4v)$/i.test(path) ? "video" : "image";
    result.push({
      path: asset.path,
      label: asset.label,
      kind,
      mimeType: typeof asset.meta?.mimeType === "string" ? asset.meta.mimeType : undefined,
      size: typeof asset.meta?.size === "number" ? asset.meta.size : undefined,
    });
    if (result.length >= 6) break;
  }
  return result;
}

async function serveStatic(pathname: string) {
  if (!(await exists(webDir))) {
    return new Response(
      "前端尚未构建。请先运行：bun run build:web\n开发时可另开终端：bun run dev:web（Vite 代理到本服务）\n",
      { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  try {
    const file = safeJoin(webDir, relative);
    if (await exists(file)) return new Response(Bun.file(file));
  } catch {
    // 路径越界或非法 → 回退到 SPA index
  }
  // SPA：未知路径回退 index.html，方便以后加前端路由。
  const index = safeJoin(webDir, "index.html");
  if (await exists(index)) return new Response(Bun.file(index));
  return new Response("Not found", { status: 404 });
}

async function serveProjectFile(projectId: string, relative: string) {
  await getProject(projectId);
  const decoded = decodeURIComponent(relative);
  const path = safeJoin(projectDir(projectId), decoded);
  if (await exists(path)) return new Response(Bun.file(path));
  // 兼容带空格/中文/特殊字符的文件名：前端按段 encodeURIComponent 过，但模型或旧数据可能只编码了一部分。
  const fallback = safeJoin(projectDir(projectId), decodeURIComponent(decodeURIComponent(relative)));
  if (fallback !== path && (await exists(fallback))) return new Response(Bun.file(fallback));
  // 静态资源走严格 404 缓存，避免浏览器把 404 缓存住后即使文件补上也不刷新。
  return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
}

function chatStream(projectId: string, message: string, attachments: ChatAttachment[] = []) {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
          abort.abort();
        }
      };
      const heartbeat = setInterval(() => send({ type: "ping" }), 15_000);
      try {
        await runAgentTurn(projectId, message, send, abort.signal, attachments);
      } catch (error) {
        if (!abort.signal.aborted) send({ type: "error", message: messageOf(error) });
      } finally {
        clearInterval(heartbeat);
        endAgentTurn(projectId);
        send({ type: "done" });
        closed = true;
        try {
          controller.close();
        } catch {
          // 客户端已经断开
        }
        flushRenderWakeQueue(projectId);
      }
    },
    cancel() {
      abort.abort();
      endAgentTurn(projectId);
      flushRenderWakeQueue(projectId);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * 渲染任务进度流：只推 job 快照，不参与对话。
 * 浏览器关掉不影响服务端渲染（后台任务自己持有 AbortController）。
 */
function jobsStream(projectId: string) {
  const encoder = new TextEncoder();
  let cleanup: (() => void) | undefined;
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
          cleanup?.();
        }
      };
      send({ type: "snapshot", jobs: listJobs(projectId) });
      const unsubscribeJobs = subscribeJobs(projectId, job => send({ type: "job", job }));
      const unsubscribeAgent = subscribeProjectAgentEvents(projectId, event => send({ type: "agent", event }));
      const heartbeat = setInterval(() => send({ type: "ping" }), 15_000);
      cleanup = () => {
        if (closed && !heartbeat) return;
        clearInterval(heartbeat);
        unsubscribeJobs();
        unsubscribeAgent();
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // 客户端已经断开
          }
        }
      };
    },
    cancel() {
      cleanup?.();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

const settings = await loadSettings();
await ensureDir(dataDir);
if (!(await exists(settingsPath))) await saveSettings(defaultSettings);
// 服务重启后内存里的渲染任务全丢，把盘上遗留的 generating 修正为 pending / failed。
setRenderTerminalHook(job => {
  void notifyRenderJobTerminal(job);
});
const repairedJobs = await reconcileStaleJobs().catch(() => [] as string[]);
if (repairedJobs.length) console.log(`[reconcile] 修正遗留渲染状态：${repairedJobs.join("、")}`);
// 素材栏丢图多半是 assets[] 重复登记或被外部删除；启动时清理并打印可疑条目，方便定位。
{
  const projectIds = (await listProjects().catch(() => [])).map(project => project.id);
  const assetIssues: string[] = [];
  for (const id of projectIds) {
    const { deduped, missing } = await reconcileProjectAssets(id).catch(() => ({ deduped: 0, missing: [] as string[] }));
    if (deduped) assetIssues.push(`${id} 去掉 ${deduped} 条重复素材`);
    if (missing.length) assetIssues.push(`${id} 缺失文件 ${missing.length} 个：${missing.slice(0, 3).join("、")}${missing.length > 3 ? "…" : ""}`);
  }
  if (assetIssues.length) console.log(`[reconcile] 素材索引：${assetIssues.join("；")}`);
}
const ffmpegCheck = await runProcess([settings.ffmpeg.ffmpegPath, "-version"]).catch(() => undefined);
if (!ffmpegCheck || ffmpegCheck.code !== 0) {
  console.warn(`[warn] 找不到 ffmpeg（${settings.ffmpeg.ffmpegPath}），学习功能将不可用`);
}

const server = Bun.serve({
  hostname: settings.server.host,
  port: settings.server.port,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/health") return json({ ok: true, dataDir });
      if (path === "/api/settings") {
        if (request.method === "GET") return json(maskSettings(settings));
        if (request.method === "PUT") {
          const body = (await request.json()) as { settings?: unknown };
          if (!body || typeof body !== "object") throw new Error("请求体必须是 { settings }");
          if (!body.settings || typeof body.settings !== "object") throw new Error("settings 必须是对象");
          const current = await loadSettings();
          const next = preserveSecrets(body.settings as typeof settings, current);
          const saved = await saveSettings(next);
          return json(maskSettings(saved));
        }
        return json({ error: "Method not allowed" }, 405);
      }
      if (path === "/api/projects") {
        if (request.method === "GET") return json({ projects: await listProjects() });
        if (request.method === "POST") {
          const body = (await request.json()) as { title?: unknown };
          const title = typeof body.title === "string" ? body.title : "";
          return json({ project: await createProject(title) });
        }
        return json({ error: "Method not allowed" }, 405);
      }
      if (path === "/api/library/packs" && request.method === "GET") {
        return json({ packs: await listStylePacks() });
      }
      if (path === "/api/skills" && request.method === "GET") {
        const query = url.searchParams.get("q")?.trim() ?? "";
        const kind = url.searchParams.get("kind") as SkillKind | null;
        if (!query && !kind) return json({ skills: (await listSkills()).map(skillToSummary) });
        const results = await searchSkills(query, { kind: kind ?? undefined, limit: 30 });
        return json({ skills: results.map(({ skill, score }) => ({ ...skillToSummary(skill), score })) });
      }
      const skillOutcomeMatch = path.match(/^\/api\/skills\/([^/]+)\/outcome$/);
      if (skillOutcomeMatch) {
        if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
        const skillId = decodeURIComponent(skillOutcomeMatch[1]);
        const body = (await request.json()) as {
          rating?: unknown;
          projectId?: unknown;
          shotId?: unknown;
          notes?: unknown;
        };
        const rating = body.rating;
        if (rating !== "good" && rating !== "mixed" && rating !== "bad") {
          throw new Error("rating 必须是 good / mixed / bad");
        }
        if (typeof body.projectId !== "string" || !body.projectId.trim()) {
          throw new Error("projectId 必填");
        }
        await getProject(body.projectId.trim());
        const skill = await recordSkillOutcome({
          skillId,
          rating,
          projectId: body.projectId.trim(),
          shotId: typeof body.shotId === "string" ? body.shotId : undefined,
          notes: typeof body.notes === "string" ? body.notes : undefined,
        });
        return json({ ok: true, skill: skillToSummary(skill) });
      }
      const skillMatch = path.match(/^\/api\/skills\/([^/]+)$/);
      if (skillMatch) {
        const skillId = decodeURIComponent(skillMatch[1]);
        if (request.method === "GET") {
          const skill = await getSkill(skillId);
          return json({ skill, markdown: skillToMarkdown(skill) });
        }
        if (request.method === "PATCH") {
          const body = (await request.json()) as { patch?: Record<string, unknown> };
          if (!body.patch || typeof body.patch !== "object") throw new Error("请求体必须是 { patch }");
          const skill = await updateSkill(skillId, body.patch);
          return json({ ok: true, skill: skillToSummary(skill) });
        }
        return json({ error: "Method not allowed" }, 405);
      }
      const shotSkillOutcomeMatch = path.match(/^\/api\/projects\/([^/]+)\/shots\/([^/]+)\/skill-outcomes$/);
      if (shotSkillOutcomeMatch) {
        if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
        const projectId = decodeURIComponent(shotSkillOutcomeMatch[1]);
        const shotId = decodeURIComponent(shotSkillOutcomeMatch[2]);
        const project = await getProject(projectId);
        const shot = project.plan.find(item => item.id === shotId);
        if (!shot) throw new Error(`分镜不存在：${shotId}`);
        const body = (await request.json()) as {
          rating?: unknown;
          notes?: unknown;
          skillIds?: unknown;
        };
        const rating = body.rating;
        if (rating !== "good" && rating !== "mixed" && rating !== "bad") {
          throw new Error("rating 必须是 good / mixed / bad");
        }
        const skillIds = Array.isArray(body.skillIds)
          ? body.skillIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim()))
          : (shot.skillIds ?? []);
        const updated = await recordSkillOutcomesForShot({
          skillIds,
          rating,
          projectId,
          shotId,
          notes: typeof body.notes === "string" ? body.notes : undefined,
        });
        const skillFeedback: { rating: "good" | "mixed" | "bad"; at: string; count: number } = {
          rating,
          at: new Date().toISOString(),
          count: updated.length,
        };
        await mutateProject(projectId, latest => {
          const target = latest.plan.find(item => item.id === shotId);
          if (!target) return;
          target.skillFeedback = skillFeedback;
          target.updatedAt = skillFeedback.at;
        });
        return json({ ok: true, skills: updated.map(skillToSummary), skillFeedback });
      }
      const skillFileMatch = path.match(/^\/skill-files\/([^/]+)\/(.+)$/);
      if (skillFileMatch) {
        const skillId = decodeURIComponent(skillFileMatch[1]);
        await getSkill(skillId);
        const file = skillEvidenceFile(skillId, decodeURIComponent(skillFileMatch[2]));
        if (!(await exists(file))) return new Response("Not found", { status: 404 });
        return new Response(Bun.file(file));
      }
      const uploadMatch = path.match(/^\/api\/projects\/([^/]+)\/uploads$/);
      if (uploadMatch) {
        if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
        const projectId = decodeURIComponent(uploadMatch[1]);
        const project = await getProject(projectId);
        if ((request.headers.get("content-type") ?? "").includes("application/json")) {
          // 从其它应用拖进来的是链接（text/uri-list / <img src>），由服务端代下载：
          // 浏览器直连第三方图床会被 CORS 挡住，而且服务端能做 SSRF 与大小校验。
          const body = (await request.json().catch(() => ({}))) as { urls?: unknown };
          const urls = Array.isArray(body.urls)
            ? [...new Set(body.urls.filter((item): item is string => typeof item === "string").map(item => item.trim()).filter(Boolean))]
            : [];
          if (!urls.length) throw new Error("没有收到图片链接");
          if (urls.length > 6) throw new Error("一次最多上传 6 个文件");
          const downloaded = [];
          for (const url of urls) downloaded.push(await downloadRemoteImage(url));
          const uploaded = [];
          await ensureDir(join(projectDir(project.id), "assets", "uploads"));
          for (const item of downloaded) {
            const base = slugify(basename(item.name, extname(item.name)), "dropped");
            const relative = `assets/uploads/${stamp()}-${crypto.randomUUID().slice(0, 8)}-${base}${item.extension}`;
            await writeFile(safeJoin(projectDir(project.id), relative), item.bytes);
            uploaded.push(addAsset(project, {
              kind: "upload",
              path: relative,
              label: `${basename(item.name, extname(item.name)) || "拖拽图片"}${item.extension}`,
              meta: { mimeType: item.mimeType, size: item.bytes.byteLength, sourceUrl: item.sourceUrl },
            }));
          }
          await saveProject(project);
          return json({ assets: uploaded });
        }
        const form = await request.formData();
        const files = form.getAll("files").filter(item => typeof item !== "string") as File[];
        if (!files.length) throw new Error("没有收到上传文件");
        if (files.length > 6) throw new Error("一次最多上传 6 个文件");
        const uploaded = [];
        const imageExtensions = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp"];
        const videoExtensions = [".mp4", ".mov", ".webm", ".m4v"];
        for (const file of files) {
          const originalName = (file.name || "upload").trim();
          const extension = extname(originalName).toLowerCase();
          const mimeType = (file.type || "").toLowerCase();
          const isImage = mimeType.startsWith("image/") || imageExtensions.includes(extension);
          const isVideo = mimeType.startsWith("video/") || videoExtensions.includes(extension);
          if (!isImage && !isVideo) throw new Error(`只支持图片或视频：${originalName}`);
          if (mimeType === "image/svg+xml" || extension === ".svg") throw new Error("不支持 SVG 上传，请使用 JPG/PNG/WebP");
          const maxBytes = isVideo ? 140 * 1024 * 1024 : 20 * 1024 * 1024;
          if (file.size > maxBytes) throw new Error(`${isVideo ? "视频" : "图片"}超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB：${originalName}`);
          const safeExtension = isVideo
            ? (videoExtensions.includes(extension) ? extension : ".mp4")
            : (imageExtensions.includes(extension) ? extension : ".jpg");
          const base = slugify(basename(originalName, extname(originalName)), "upload");
          const relative = `assets/uploads/${stamp()}-${crypto.randomUUID().slice(0, 8)}-${base}${safeExtension}`;
          const absolute = safeJoin(projectDir(project.id), relative);
          await ensureDir(join(projectDir(project.id), "assets", "uploads"));
          await writeFile(absolute, new Uint8Array(await file.arrayBuffer()));
          uploaded.push(addAsset(project, {
            kind: "upload",
            path: relative,
            label: originalName,
            meta: { mimeType: file.type || (isVideo ? "video/mp4" : "image/jpeg"), size: file.size, originalName },
          }));
        }
        await saveProject(project);
        return json({ assets: uploaded });
      }
      const jobsMatch = path.match(/^\/api\/projects\/([^/]+)\/jobs$/);
      if (jobsMatch) {
        const projectId = decodeURIComponent(jobsMatch[1]);
        await getProject(projectId);
        if (request.method === "GET") return json({ jobs: listJobs(projectId) });
        if (request.method === "POST") {
          const body = (await request.json()) as { shotId?: unknown; action?: unknown };
          const shotId = typeof body.shotId === "string" ? body.shotId.trim() : "";
          const action = typeof body.action === "string" ? body.action : "resume";
          if (action === "flush") {
            // 把内存轮询中的 videoId 写回盘，修复旧快照覆盖导致的「假无任务」
            return json({ flushed: await flushLiveVideoIds(projectId) });
          }
          if (!shotId) throw new Error("缺少 shotId");
          if (action !== "resume") throw new Error(`不支持的操作：${action}`);
          const job = startResumeJob(projectId, shotId);
          return json({ job });
        }
        return json({ error: "Method not allowed" }, 405);
      }
      const jobsStreamMatch = path.match(/^\/api\/projects\/([^/]+)\/jobs\/stream$/);
      if (jobsStreamMatch) {
        if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
        const projectId = decodeURIComponent(jobsStreamMatch[1]);
        await getProject(projectId);
        return jobsStream(projectId);
      }
      const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/chat)?$/);
      if (projectMatch) {
        const projectId = decodeURIComponent(projectMatch[1]);
        if (projectMatch[2]) {
          if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
          const body = (await request.json()) as { message?: unknown; attachments?: unknown };
          const message = typeof body.message === "string" ? body.message.trim() : "";
          const project = await getProject(projectId);
          const attachments = normalizeChatAttachments(body.attachments, project);
          if (!message && !attachments.length) throw new Error("消息不能为空");
          if (!tryBeginAgentTurn(projectId)) return json({ error: "该项目正在进行一轮对话，请等当前任务结束" }, 409);
          return chatStream(projectId, message, attachments);
        }
        if (request.method === "PATCH") {
          const body = (await request.json()) as { title?: unknown };
          const title = typeof body.title === "string" ? body.title : "";
          return json({ project: await renameProject(projectId, title) });
        }
        if (request.method === "DELETE") {
          if (isAgentTurnActive(projectId)) {
            return json({ error: "该项目正在对话中，请等当前任务结束后再删除" }, 409);
          }
          const running = listJobs(projectId).some(job => job.status === "running");
          if (running) {
            return json({ error: "该项目有渲染任务进行中，请等结束后再删除" }, 409);
          }
          clearJobsForProject(projectId);
          await deleteProject(projectId);
          return json({ ok: true, id: projectId });
        }
        if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
        const project = await getProject(projectId);
        const manifest = await getManifest(project);
        const messages = await readSession<LlmMessage>(projectId);
        return json({
          project,
          messages: historyMessages(messages),
          shots: manifest?.shots.map(shot => ({
            id: shot.id,
            start: shot.start,
            end: shot.end,
            duration: shot.duration,
            keyframe: shot.keyframe,
            clip: shot.clip,
            shotSize: shot.annotation?.shotSize,
            movement: shot.annotation?.movement,
            description: shot.annotation?.description,
          })) ?? [],
        });
      }
      const fileMatch = path.match(/^\/files\/([^/]+)\/(.+)$/);
      if (fileMatch) return serveProjectFile(decodeURIComponent(fileMatch[1]), fileMatch[2]);
      if (path.startsWith("/api/")) return json({ error: "Not found" }, 404);
      return serveStatic(path);
    } catch (error) {
      console.error(error);
      return json({ error: messageOf(error) }, 500);
    }
  },
});

console.log(`StyleLoom Agent: http://${server.hostname}:${server.port}`);
console.log(`数据目录: ${dataDir}`);
console.log(`设置文件: ${settingsPath}`);
