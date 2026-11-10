import { join } from "node:path";
import { dataDir, loadSettings, maskSettings, preserveSecrets, saveSettings, settingsPath, webDir, defaultSettings } from "./config";
import { ensureDir, exists, readJsonIfExists, safeJoin } from "./util/fs";
import { createProject, getManifest, getProject, listProjects, projectDir, readSession } from "./store/projects";
import { listStylePacks } from "./store/library";
import { getSkill, listSkills, searchSkills, skillEvidenceFile, skillToMarkdown, skillToSummary } from "./store/skills";
import type { SkillKind } from "./types";
import { runAgentTurn } from "./agent/loop";
import type { LlmMessage } from "./providers/llm";
import { runProcess } from "./util/ffmpeg";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function historyMessages(messages: LlmMessage[]) {
  return messages
    .filter(message => (message.role === "user" || message.role === "assistant") && typeof message.content === "string" && message.content.trim())
    .map(message => ({ role: message.role, content: message.content as string }));
}

async function serveStatic(pathname: string) {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const file = safeJoin(webDir, relative);
  if (!(await exists(file))) return new Response("Not found", { status: 404 });
  return new Response(Bun.file(file));
}

async function serveProjectFile(projectId: string, relative: string) {
  await getProject(projectId);
  const path = safeJoin(projectDir(projectId), decodeURIComponent(relative));
  if (!(await exists(path))) return new Response("Not found", { status: 404 });
  return new Response(Bun.file(path));
}

const activeProjects = new Set<string>();

function chatStream(projectId: string, message: string) {
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
        await runAgentTurn(projectId, message, send, abort.signal);
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

const settings = await loadSettings();
await ensureDir(dataDir);
if (!(await exists(settingsPath))) await saveSettings(defaultSettings);
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
      const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/chat)?$/);
      if (projectMatch) {
        const projectId = decodeURIComponent(projectMatch[1]);
        if (projectMatch[2]) {
          if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
          const body = (await request.json()) as { message?: unknown };
          const message = typeof body.message === "string" ? body.message.trim() : "";
          if (!message) throw new Error("消息不能为空");
          await getProject(projectId);
          if (activeProjects.has(projectId)) return json({ error: "该项目正在进行一轮对话，请等当前任务结束" }, 409);
          activeProjects.add(projectId);
          return chatStream(projectId, message);
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

console.log(`VideoCopy Agent: http://${server.hostname}:${server.port}`);
console.log(`数据目录: ${dataDir}`);
console.log(`设置文件: ${settingsPath}`);
