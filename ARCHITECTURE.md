# 架构说明

## 设计原则

1. **学习与生成解耦**：学习产出纯 JSON（`styleBible` + `slice.json`），生成只消费 JSON，不依赖某次对话。
2. **每一层都能单独跑**：切片、标注、归纳、提示词、提交生成都是独立函数，Agent 只是调度器。
3. **可恢复**：逐镜分析每完成一镜就落盘；H3 先创建任务再轮询，`videoId` 会写回分镜。
4. **费用边界明确**：`build_shot_prompt` 不花钱；`generate_shot` 必须 `confirmed=true`。
5. **零运行时依赖**：Bun 自带 HTTP、spawn、文件与 WebSocket/Stream；只有 devDependencies。

## 请求生命周期

```
浏览器 POST /api/projects/:id/chat
        │
        ▼
 runAgentTurn (agent/loop.ts)
        │  system prompt = 角色规则 + 项目快照 + 能力状态
        ▼
 OpenAI 兼容 /chat/completions (工具调用)
        │
        ├── 文本 ──▶ SSE message
        └── tool_calls
                │
                ▼
        executeTool (agent/tools.ts)
           ├─ study_reference_video → learn/study.ts
           ├─ plan_shots / build_shot_prompt → generate/prompt.ts
           ├─ generate_still → providers/image.ts
           └─ generate_shot → providers/video/icompify.ts
                │
                ├── progress ──▶ SSE progress
                ├── 状态变化 ──▶ SSE state（右侧面板刷新）
                └── 结果 JSON ──▶ 回填给模型
        │
        ▼
 下一轮模型调用，直到无 tool_calls
```

SSE 事件：`message`、`tool_start`、`progress`、`tool_end`、`state`、`error`、`ping`、`done`。心跳每 15 秒，防止代理断流。

## 学习管线

### 1. 切片 `learn/slice.ts`

- `ffprobe` 读取时长、尺寸、帧率、音轨。
- 切点检测：`ffmpeg -vf "select='gt(scene,0.32)',metadata=print:file=-"`，解析 `pts_time` 与 `lavfi.scene_score`。
- 过滤：距上一刀 < `minShotSeconds` 的切点丢弃；超过 `maxShots` 退化为等分切片（ACT 注释标明了这个上限）。
- 每镜产物：
  - `frame.jpg`：镜头中点，960 宽；
  - `sample1..3.jpg`：15% / 50% / 85%，640 宽，供视觉模型比较运动；
  - `clip.mp4`：按镜头边界重编码，供 Ref2VA 当参考视频；
  - 整片 `audio.m4a`。
- 写入 `learning/slice.json`（`SliceManifest`）。

### 2. 逐镜标注 `learn/annotate.ts`

- 每个镜头一次视觉模型请求（多图按时间顺序），要求严格 JSON。
- 字段：景别、角度、运镜、灯光、调色、构图、镜头感、主体、服装、场景、动作、表情、对白、声音、描述、`h3ShotBlock`、风格标签。
- 只有单帧时强制 `movement = unable to determine`，避免模型编造运镜。
- 每镜成功即写回 manifest；重跑时跳过已有标注（`force` 可重标）。
- 失败重试一次；仍失败则抛错，已完成的镜头保留。

### 3. 归纳 `learn/distill.ts`

- 把逐镜标注压缩成观察记录，文本模型输出：
  - `style`（含统一的 `stylePrefix`）、`characters`、`locations`、`cameraGrammar`、`rhythm`、`prompting`、`sound`。
- 参考镜头 id 必须来自真实 manifest；角色/场景的 `refImages` 由 id 映射到关键帧。
- 无法映射时按主体/场景文本做弱匹配，仍失败则留空。
- 归纳失败回退到规则版（频率统计），保证切片与标注结果不浪费；`learning.warning` 记录原因。
- 输出 `learning/styleBible.json`、`learning/styleBible.md`，并保存到 `data/library/packs/` 供其它项目套用。

### 4. 技能抽取 `learn/skills.ts`

学习完成后自动执行，把「这部片是什么样」提炼成「以后遇到类似镜头怎么做」：

- 一次文本模型调用，输入风格圣经 + 逐镜观察，输出 3–8 条候选技能（kind、中文规则、英文 prompt fragment、适用/避免条件、证据镜头）。
- 与已有技能做相似度匹配（标签 Jaccard + 文本 Jaccard + prompt fragment Jaccard，阈值 0.52）；相似则合并证据与标签，版本 +1；否则新建 candidate。
- 复制证据关键帧到 `data/skills/<id>/evidence/`，项目删除后技能仍可读。
- LLM 失败退回规则版：运镜语法、灯光、调色、节奏、风格前缀、避坑清单。
- 技能抽取失败不影响学习结果，只写 warning。

### 技能生命周期

```
抽取 → candidate（置信度约 0.32）
  ├─ 新参考片命中 → evidence+1，置信度上升
  ├─ 生成后好评 → active
  ├─ 3 个独立项目证据 → active
  ├─ 差评≥2 且多于正面 → deprecated
  └─ merge_skills → 源技能 deprecated + mergedInto
```

置信度 = 基础 0.32 + 证据加成（最多 0.25）+ 反馈加成（最多 0.4）+ 使用加成（最多 0.08）。
LLM 自评不直接进入置信度，必须靠独立证据或真实反馈。

Agent 在规划前 `search_skills`、命中后 `read_skill`，把 prompt fragment 落到分镜；`plan_shots` / `generate_shot` 记录 `skillIds`，生成后 `record_skill_outcome` 回写反馈。

### 为什么用「风格圣经」而不是向量库

短视频生产需要的是**可执行的约束**：身份锚点、服装、场景布局、运镜幅度/速度、光线方向。把它们写成结构化字段，比相似度检索更直接地进入 H3 提示词；同时人也能读懂和修正。

## 小红书下载

```
用户链接/分享文案
  → 提取 URL
  → xhslink.com 短链跟随跳转，尽量拿到带 xsec_token 的完整笔记地址
  → yt-dlp（--cookies-from-browser + Referer + UA + bv*+ba/b + mp4）
  → 解析 VIDEOCOPY_META 输出行拿标题/id/filepath
  → ffprobe 校验
  → 复制进项目 assets/sources/
```

- 浏览器 Cookie 由 yt-dlp 直接读取，本项目不保存 Cookie。
- 失败信息会区分缺 token、未登录、yt-dlp 缺失、私密/删除等情况。
- 学习工具识别到小红书链接时自动先下载，再进入切片管线。

## 生成决策

`generate/prompt.ts:prepareReferences` 按优先级决定模式：

| 条件 | 官方模式 | icompify task / 模型 | 说明 |
| --- | --- | --- | --- |
| 显式 `firstFrame` + `lastFrame` | FL2VA | `fl2va` / `minimax-h3-fl2va` | 精确首尾帧 |
| 显式 `firstFrame` | I2VA | `fl2va` / `minimax-h3-fl2va` | 首帧锚定 |
| 有参考片段 `referenceShotIds` | Ref2VA | `ref2va` / `minimax-h3-ref2va` | 参考图 + 参考视频 |
| 只有角色/场景参考图 | I2VA | `fl2va` / `minimax-h3-fl2va` | 第一张主体参考图当首帧 |
| 都没有 | T2VA | `t2va` / `minimax-h3-fl2va` | 纯文本 |

参考图顺序：角色（`<Subject N>` / `<Picture N>`）→ 场景（`<Picture N>`）→ 参考片段（`<Video N>`）。最多 4 图 / 3 视频，与平台限制一致。

`shot.generationMode` 可以强制模式（`auto` / `t2va` / `i2va` / `fl2va` / `l2va` / `ref2va`）。实测“人物定妆照 + 空场景照”两张参考图走 `ref2va` 时，身份、服装、房间与构图明显比纯文字稳定；纯文字更适合不想依赖图片模型、且允许一定漂移的场景。

提示词有两种来源：

1. **LLM 编写**：把分镜、风格圣经、参考标签交给提示词导演模型，要求按官方结构输出；长度超限会再请求一次压缩。
2. **确定性骨架**：任何字段缺失、结构不对、对齐句被改写、或模型调用失败时回退。骨架本身保证结构合法。

校验规则（`validatePrompt`）：字段齐全且顺序正确、对齐句逐字匹配、Ref2VA 必须有六段、长度 ≤ 7000。

## 数据模型

`Project`（`project.json`）是唯一状态源：

- `brief`：需求
- `learning`：学习状态、错误/警告、镜头数与源尺寸
- `styleBible`：风格圣经（可内联，体积可控）
- `plan[]`：分镜、提示词、状态、成片路径、`videoId`
- `assets[]`：所有产物的相对路径索引

`SliceManifest`（`learning/slice.json`）保存每个镜头的时间、关键帧、采样、片段与标注。分镜只存 `referenceShotIds`，不复制片段。

`Skill`（`data/skills/<id>/skill.json`）是全局资产：规则、prompt fragment、证据（项目/镜头/证据图）、反馈、置信度、状态、版本与修订历史。`SKILL.md` 由 JSON 生成，便于人和 Agent 阅读。

## 工具目录

| 工具 | 作用 | 费用 |
| --- | --- | --- |
| `update_brief` | 记录需求 | 无 |
| `study_reference_video` | 切片 + 标注 + 归纳 + 存风格包 | VLM/LLM |
| `read_style_bible` | 按 section 读取风格圣经 | 无 |
| `read_learning_shots` | 读取逐镜明细 | 无 |
| `download_xhs_video` | 下载小红书笔记视频到项目 | 无 |
| `search_skills` / `read_skill` | 检索/读取全局技能 | 无 |
| `extract_skills` | 从当前项目补跑技能抽取 | 文本模型 |
| `record_skill_outcome` | 记录技能使用效果 | 无 |
| `update_skill` / `merge_skills` | 修正/合并技能 | 无 |
| `update_style_bible` | 人工修正（深合并） | 无 |
| `plan_shots` | 写入分镜 | 无 |
| `build_shot_prompt` | 生成并校验 H3 提示词 | 文本模型 |
| `generate_still` | 定妆照/场景照（可回退参考帧） | 图片模型 |
| `generate_shot` | H3 生成单镜（需确认） | **视频计费** |
| `list_assets` | 查看状态 | 无 |
| `list_style_packs` | 查看风格包 | 无 |
| `apply_style_pack` | 套用风格包并复制引用素材 | 无 |
| `set_stage` | 更新阶段 | 无 |

## 扩展点

- **换文本/视觉模型**：只改 `settings.json`。任何 OpenAI 兼容网关都能用；工具调用需要网关支持 `tools`。
- **换视频供应商**：实现 `generateVideoJob` 同签名函数，或在 `providers/video/` 增加分支。
- **换图片供应商**：`providers/image.ts` 支持 OpenAI `/images/generations` 与 OpenRouter `/images`（Qwen Image），通过 `image.api` 切换；返回 `{ bytes, mimeType, model }`。
- **加镜头技能**（例如口型、音乐、转场）：新工具 + `agent/prompt.ts` 里的流程说明；重活放到 `src/generate/`。
- **接工作流画布**：`styleBible`、`slice.json`、`plan[]` 都是稳定 JSON，可直接映射到节点/连线。
- **换技能检索**：`store/skills.ts` 的 `searchSkills` 是唯一检索入口，可替换为 embedding/向量库而不影响工具层。
- **加下载源**：在 `providers/download/` 增加适配器，保持 `{path,title,duration,...}` 返回；学习工具按 URL 分流。

## 上限与后续

- 切片检测是启发式，不识别渐变转场；长片按等分退化。
- 标注串行，无并发限流；生产环境建议按供应商 QPS 加队列。
- 未做整片拼接、字幕、混音。
- `generate_shot` 尚未做真实扣费验证；首次使用建议 4 秒单镜。
- 风格包不做版本合并，套用是整体替换。
- 技能检索是词法匹配，不做语义向量；反馈不会自动改写规则，需要 Agent/人工 `update_skill`。
- 小红书下载依赖 yt-dlp 和浏览器登录态，私密/地区限制/风控笔记会失败。
