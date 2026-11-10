import { createInterface } from "node:readline/promises";
import { createProject, getProject, listProjects } from "./store/projects";
import { runAgentTurn } from "./agent/loop";
import type { AgentEvent } from "./types";

function printEvent(event: AgentEvent) {
  if (event.type === "message") {
    console.log(`\n${event.role === "user" ? "你" : "Agent"}：${event.content}\n`);
  } else if (event.type === "tool_start") {
    console.log(`→ ${event.name} ${JSON.stringify(event.args).slice(0, 300)}`);
  } else if (event.type === "tool_end") {
    console.log(`${event.ok ? "✓" : "✗"} ${event.name} ${event.preview.slice(0, 300)}`);
  } else if (event.type === "progress") {
    process.stdout.write(`\r  ${event.percent}% ${event.label}`.padEnd(100));
  } else if (event.type === "error") {
    console.error(`\n[错误] ${event.message}\n`);
  } else if (event.type === "state") {
    process.stdout.write("\r".padEnd(101) + "\r");
  }
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const projects = await listProjects();
if (!projects.length) {
  const title = (await rl.question("还没有项目，输入项目名创建：")).trim() || "我的第一个视频";
  const project = await createProject(title);
  console.log(`已创建项目：${project.id}`);
  projects.push({ id: project.id, title: project.title, stage: project.stage, updatedAt: project.updatedAt, shotCount: 0, learning: "none", hasBible: false });
}
console.log("\n项目列表：");
projects.forEach((project, index) => console.log(`  ${index + 1}. ${project.title}（${project.id}）`));
const choice = (await rl.question("选择项目编号（回车选 1）：")).trim();
const selected = projects[Number(choice || 1) - 1] ?? projects[0];
await getProject(selected.id);
console.log(`\n进入项目：${selected.title}。输入内容开始对话，Ctrl+C 退出。\n`);

while (true) {
  const message = (await rl.question("你：")).trim();
  if (!message) continue;
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);
  try {
    await runAgentTurn(selected.id, message, printEvent, controller.signal);
  } catch (error) {
    console.error(`\n[错误] ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}
