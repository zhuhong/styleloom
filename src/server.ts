import { basename, extname, join } from "node:path";
import { writeFile } from "node:fs/promises";
import { dataDir, loadSettings, maskSettings, preserveSecrets, saveSettings, settingsPath, webDir, defaultSettings } from "./config";
import { ensureDir, exists, readJsonIfExists, safeJoin, slugify, stamp } from "./util/fs";
import { addAsset, createProject, getManifest, getProject, listProjects, projectDir, readSession, saveProject } from "./store/projects";
import { listStylePacks } from "./store/library";
import { getSkill, listSkills, searchSkills, skillEvidenceFile, skillToMarkdown, skillToSummary } from "./store/skills";
import type { ChatAttachment, Project, SkillKind } from "./types";
import { runAgentTurn } from "./agent/loop";
import type { LlmMessage } from "./providers/llm";
import { runProcess } from "./util/ffmpeg";
import { listJobs, reconcileStaleJobs, startResumeJob, subscribeJobs } from "./generate/jobs";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function historyMessages(messages: LlmMessage[]) {
  return messages
    .filter(message => (message.role === "user" || message.role === "assistant")
      && ((typeof message.content === "string" && message.content.trim()) || message.attachments?.length))
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
  const path = safeJoin(projectDir(projectId), decodeURIComponent(relative));
  if (!(await exists(path))) return new Response("Not found", { status: 404 });
  return new Response(Bun.file(path));
}

const activeProjects = new Set<string>();

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
        activeProjects.delete(projectId);
        send({ type: "done" });
        closed = true;
        try {
          controller.close();
        } catch {
          // 客户端已经断开
        }
      }
    },
    cancel() {
      abort.abort();
      activeProjects.delete(projectId);
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
      const unsubscribe = subscribeJobs(projectId, job => send({ type: "job", job }));
      const heartbeat = setInterval(() => send({ type: "ping" }), 15_000);
      cleanup = () => {
        if (closed && !heartbeat) return;
        clearInterval(heartbeat);
        unsubscribe();
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
const repairedJobs = await reconcileStaleJobs().catch(() => [] as string[]);
if (repairedJobs.length) console.log(`[reconcile] 修正遗留渲染状态：${repairedJobs.join("、")}`);
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
      const skillMatch = path.match(/^\/api\/skills\/([^/]+)$/);
      if (skillMatch && request.method === "GET") {
        const skill = await getSkill(decodeURIComponent(skillMatch[1]));
        return json({ skill, markdown: skillToMarkdown(skill) });
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
          if (!shotId) throw new Error("缺少 shotId");
          if (body.action !== "resume") throw new Error(`不支持的操作：${String(body.action)}`);
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
          if (activeProjects.has(projectId)) return json({ error: "该项目正在进行一轮对话，请等当前任务结束" }, 409);
          activeProjects.add(projectId);
          return chatStream(projectId, message, attachments);
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
