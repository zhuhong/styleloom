# 仓库规范

本文件适用于整个仓库，给后续接手的人/Agent。

## 技术栈

- Bun + TypeScript，ES Modules，无运行时第三方依赖。
- 前端是原生 HTML/CSS/JS，**不引入打包器**，`web/` 直接由 `src/server.ts` 静态托管。
- `ffmpeg` / `ffprobe` 通过 `Bun.spawn` 调用。

## 常用命令

```bash
bun install
bun run typecheck
bun start            # http://127.0.0.1:8787
bun run chat         # 终端对话
```

## 目录边界

- `src/agent/`：对话循环、系统提示词、工具注册。业务实现不写在这里。
- `src/learn/`：参考片学习（切片、标注、归纳、编排）。
- `src/generate/`：生成侧（参考决策、H3 提示词、单镜生成、定妆照）。
- `src/providers/`：外部模型/平台适配。只做协议转换，不写业务状态。
- `src/store/`：项目、manifest、会话、风格包、全局技能持久化。
- `src/util/`：文件与 ffmpeg 原语。
- `src/providers/download/`：外部素材下载适配器（小红书/yt-dlp）。
- `web/`：只通过 `/api`、`/files`、`/skill-files` 访问后端。

## 代码约定

- 回答与注释用中文；变量、函数、文件名用小驼峰。
- 双引号、分号、两空格缩进。
- 文件操作统一走 `src/util/fs.ts`；ffmpeg 统一走 `src/util/ffmpeg.ts`；模型调用统一走 `src/providers/`。
- 项目内文件路径一律存**项目相对路径**（POSIX 风格），读写时用 `safeJoin` 校验边界。
- 全局技能存 `data/skills/<id>/`，证据图复制进技能目录，不依赖原项目。
- 技能置信度只由证据与真实反馈计算；模型自评不直接抬高置信度。
- 所有覆盖写使用原子写（`writeJson` / `writeText`）。
- 有意简化或已知上限用 `ACT:` 注释写清楚。

## 成本与安全

- `generate_shot` 必须要求 `confirmed=true`；任何新增计费工具都要保持这个确认门槛。
- 密钥只存在 `data/settings.json`（gitignored）。接口返回设置时必须打码。
- 不要把 API Key、完整平台响应或 base64 素材写进日志/提交。
- `/files/:projectId/*` 必须先校验项目存在，再 `safeJoin`。
- 不默认复刻参考片中的人物身份；在提示词与文档中保持“借风格/运镜/美术”的边界。
- 小红书下载依赖 yt-dlp 与浏览器登录态；不保存 Cookie，不绕过登录/付费墙，不批量抓取。
- 技能是长期资产：优先 `deprecated`/`merge_skills`，不要直接删目录。

## 验证

- 改完先 `bun run typecheck`，再启动服务做一次 HTTP/SSE 手动验证。
- 涉及切片/标注/技能抽取的改动，用一段 10–20 秒、至少 2 个切点的视频做冒烟；标注成本可控。
- 小红书下载用无效笔记验证错误分支即可，真实笔记需用户提供链接后再测。
- 不新增测试框架或测试文件；验证结果如实说明。真实 H3 出片属于付费操作，未获用户确认不要执行。

## 关键数据契约

- `Project`（`project.json`）：`brief`、`learning`、`styleBible`、`plan[]`、`assets[]`。
- `SliceManifest`（`learning/slice.json`）：镜头时间、关键帧、采样、片段、`annotation`。
- `StyleBible`：`style`、`characters`、`locations`、`cameraGrammar`、`rhythm`、`prompting`、`sound`。
- `Skill`：`kind`、`status`、`instruction`、`promptFragment`、`evidence`、`outcomes`、`confidence`、`version`。
- 改动这些结构时，同步更新 `src/types.ts`、`ARCHITECTURE.md`、`web/app.js` 的渲染。

## 工具新增流程

1. 在 `src/agent/tools.ts` 增加 `toolSpecs` 项与 handler。
2. 计费/耗时操作加 `confirmed` 参数与进度事件。
3. 更新 `agent/prompt.ts` 的流程说明（否则模型不会正确使用）。
4. 计费/下载/技能类工具要补失败提示与恢复路径。
5. 更新 README、ARCHITECTURE 与对应 `docs/*.md`。
