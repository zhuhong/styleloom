# VideoCopy

一个会用**参考片学习**的视频生成 Agent。

和 Toonflow 一样，它通过对话把想法变成分镜、定妆照、场景照和视频；关键区别是：它先把用户给的参考视频**拆成镜头并逐帧拉片**，归纳出可复用的「风格圣经」——角色身份与服装、场景美术、运镜语法、节奏、灯光与调色，再用这些知识驱动 MiniMax H3 生成新视频。

每次学习还会把方法沉淀成**跨项目技能**（怎么运镜、怎么布光、怎么写提示词、怎么避坑），生成后的用户反馈会继续调整技能置信度。参考片可以直接是本地文件，也可以是小红书笔记链接。

```
参考视频 ──ffmpeg──▶ 镜头切片/关键帧/参考片段
                        │
                        ▼
                视觉模型逐镜头拉片（景别/角度/运镜/灯光/主体/场景/动作/声音）
                        │
                        ▼
                语言模型归纳「风格圣经」+ 可复用风格包
                        │
                        ▼
                抽取跨项目技能（证据/反馈/置信度持续累积）
                        │
         ┌──────────────┼───────────────┐
         ▼              ▼               ▼
     定妆照/场景照    分镜与 H3 提示词   参考片段（运镜/节奏）
         └──────────────┴───────────────┘
                        │
                        ▼
              icompify / MiniMax H3 生成视频
```

## 快速开始

环境：macOS / Linux、[Bun](https://bun.sh) 1.3+、本机 `ffmpeg` / `ffprobe`。
小红书下载需要 `yt-dlp`（可选）：`brew install yt-dlp`。

```bash
bun install
mkdir -p data && cp settings.example.json data/settings.json   # data/ 已被 gitignore
# 编辑 data/settings.json，至少填 LLM 与 icompify 的 Key
bun start
# 打开 http://127.0.0.1:8787
```

也可以在终端里对话：

```bash
bun run chat
```

### 配置

`data/settings.json`（或网页右上角「设置」）：

| 字段 | 说明 |
| --- | --- |
| `llm.baseUrl` / `apiKey` / `model` | OpenAI 兼容的文本模型。默认接本机 LiteLLM `http://localhost:4000/v1` |
| `llm.visionModel` | 支持图片输入的模型。默认 `deepseek-v4.1-flash`（经 LiteLLM）；也可换 Gemini 等 |
| `video.baseUrl` / `apiKey` | icompify 开放平台，默认 `https://api.icompify.com` |
| `video.model` / `referenceModel` | `minimax-h3-fl2va`（文生/首尾帧）、`minimax-h3-ref2va`（参考图/参考视频） |
| `image.*` | 可选。OpenAI 兼容 `/images/generations`，用于生成定妆照/场景照；不配置则回退为参考片关键帧 |
| `xhs.*` | 小红书下载：`ytDlpPath`、`cookiesFromBrowser`（chrome/safari/留空）、`referer`、`userAgent`、超时 |
| `ffmpeg.*` | 二进制路径，默认 `ffmpeg` / `ffprobe` |
| `learning.*` | 切镜阈值、最短镜头、最多镜头数、每镜采样帧数、是否切出参考片段 |

示例输出：[风格圣经](docs/examples/style-bible-example.md) · [Ref2VA 提示词](docs/examples/ref2va-prompt-example.txt) · [技能](docs/examples/skill-example.md) · [真实生成案例](docs/examples/generated-shot-example.md)。

专题文档：[技能库](docs/skills.md) · [小红书下载](docs/xhs-download.md) · [H3 提示词](docs/h3-prompting.md)。

## 在网页里怎么用

1. **给素材**：本地视频路径、小红书笔记链接（建议带 `xsec_token` 的完整 URL），或直接说想法。
   例：“学习 `/path/reference.mp4` 的运镜和灯光，做一个 8 秒的雨夜街头对话镜头”。
2. **Agent 学习**：小红书链接会先 `download_xhs_video` 下载，再调用 `study_reference_video`；页面实时显示切片、逐镜分析、归纳和技能抽取进度。完成后右侧出现镜头缩略图、风格圣经与技能库。
3. **确认学习结果**：Agent 用中文汇报角色、场景、运镜和节奏；可以要求修正（`update_style_bible`）。
4. **出定妆照 / 场景照**：`generate_still`。没有配置图片模型时，会把参考关键帧复制为参考图并明确说明。
5. **写分镜**：`plan_shots`，每镜 4–15 秒整数；想让某镜继承参考片运镜，就设置 `referenceShotIds`。
6. **预览提示词**：`build_shot_prompt`，不产生费用。会按素材自动选择 T2VA / I2VA / FL2VA / L2VA / Ref2VA。
7. **确认后生成**：`generate_shot(confirmed=true)`。Agent 必须先展示分镜和提示词并得到你的明确同意。
8. **回看与反馈**：右侧「分镜」里直接播放成片；告诉 Agent 某个镜头“好/一般/差”，它会用 `record_skill_outcome` 更新技能置信度。
9. **持续积累**：第二部参考片命中同一条技能时会合并证据；3 个独立项目证据或 1 次好评会让技能升级为 active。

## 产物结构

```
data/
├── settings.json
├── cache/xhs/<noteId>-<时间>/             # yt-dlp 原始下载
├── library/packs/<projectId>.json        # 可复用的学习风格包
├── skills/<id>/
│   ├── skill.json                        # 技能规则、证据、反馈、置信度、版本
│   ├── SKILL.md                          # 人/Agent 可读
│   └── evidence/                         # 证据关键帧（项目删除后仍保留）
└── projects/<projectId>/
    ├── project.json                      # 需求、风格圣经、分镜、素材索引
    ├── session.json                      # 对话历史
    ├── learning/
    │   ├── slice.json                    # 镜头清单（时间、关键帧、片段、标注）
    │   ├── styleBible.json / .md         # 风格圣经（机器读 / 人读）
    │   ├── audio.m4a
    │   └── shots/s01/{frame.jpg,sample*.jpg,clip.mp4}
    └── assets/
        ├── sources/                      # 小红书等外部下载的参考视频
        ├── stills/                       # 定妆照 / 场景照
        └── videos/                       # H3 生成的镜头
```

## 项目结构

```
src/
├── server.ts                 # Bun HTTP + SSE，静态页面
├── cli.ts                    # 终端对话
├── config.ts                 # settings 读写（密钥打码）
├── types.ts                  # 领域模型
├── agent/
│   ├── loop.ts               # LLM ↔ 工具循环
│   ├── prompt.ts             # 系统提示词 + 项目状态快照
│   └── tools.ts              # 20 个 Agent 工具
├── learn/
│   ├── slice.ts              # ffmpeg 切镜、关键帧、片段、音轨
│   ├── annotate.ts           # 视觉模型逐镜拉片（可断点续跑）
│   ├── distill.ts            # 归纳风格圣经（失败回退规则版）
│   ├── skills.ts             # 从学习结果抽取/合并跨项目技能
│   └── study.ts              # 学习链路编排
├── generate/
│   ├── prompt.ts             # 参考素材决策 / H3 结构化提示词 / 校验
│   ├── shot.ts               # 单镜头生成
│   └── still.ts              # 定妆照 / 场景照
├── providers/
│   ├── llm.ts                # OpenAI 兼容文本 + 视觉 + 工具调用
│   ├── image.ts              # OpenAI 兼容出图
│   ├── download/xhs.ts       # 小红书短链展开 + yt-dlp + 校验
│   └── video/icompify.ts     # icompify 创建/轮询/下载
├── store/
│   ├── projects.ts           # 项目、manifest、会话
│   ├── library.ts            # 风格包保存/套用
│   └── skills.ts             # 技能存储、检索、反馈、合并、SKILL.md
└── util/                     # 文件、ffmpeg
web/                          # 无构建步骤的原生页面
```

## 当前状态

已实际验证：

- 本地切片：`ffmpeg` 切点检测 + 关键帧/采样/片段/音轨，12 秒 3 镜样本通过。
- 学习链路：`deepseek-v4.1-flash` 逐镜分析 + 归纳风格圣经，3 镜约 4 分钟，角色/场景/运镜/灯光/节奏输出可用。
- 技能库：从同一份学习结果自动抽取 7 条技能（camera/composition/lighting/rhythm/prompt/sound），写入 `skill.json` + `SKILL.md` + 证据图；记录一次好评后 candidate → active，置信度 0.39 → 0.79；`search_skills` 中文检索命中。
- Agent 工具链：通过 LiteLLM 真实跑通 `read_learning_shots → update_brief → plan_shots → build_shot_prompt`，生成 6309 字符的合法 Ref2VA 提示词。
- 小红书下载：`yt-dlp 2026.10.26` + Chrome 登录态，已用真实笔记 `6ad5e4c0…`（带 `xsec_token`）验证成功：9.45 秒、720×1280、含音轨，自动复制进项目 `assets/sources/`；进度条、metadata、ffprobe 校验均正常。短链/URL/分享文案解析与失败分支也已验证。
- 服务端 / SSE / 设置接口 / 项目文件访问 / 技能 API 与页面渲染。

已实际扣费验证：

- H3 T2VA 出片：9 秒 / 9:16，768×1344，含音轨，`video_id=video_9e930951…`，排队+推理约 141 秒。VLM 三帧质检判定“高度符合”，存在轻微机位漂移、手指与画框接触略融合、1s 鞋尖轻微裁切。详见 [generated-shot-example.md](docs/examples/generated-shot-example.md)。
- 技能使用与反馈闭环：本次 8 条技能 `used+1`，自动质检后 4 条升级 active、3 条保持 candidate。

尚未验证：

- I2VA / FL2VA / Ref2VA 的真实出片（T2VA 已验证；请求格式与 Toonflow provider 一致）。

已知限制：

- 长视频超过 `learning.maxShots` 会退化为等分切片，丢失真实切点（代码中有 ACT 标注）。
- 逐镜分析串行执行，40 镜约 10–20 分钟；失败可从已完成镜头继续。
- 参考视频按“只借风格/运镜/美术”设计，不默认复刻原片人物身份；用户明确要求复刻时需自行确认版权。
- 图片模型只支持文本生图，未接图生图/参考图编辑。
- 风格包套用只复制被引用的图片和片段，不复制原项目分镜。
- 小红书私密/已删除/地区限制笔记无法下载；Safari 读 Cookie 需要给终端完全磁盘访问权限。
- 技能检索是词法匹配，不是向量检索；技能很多时可再升级。

## 路线图

- 镜头级并行标注 + 断点重试队列
- 技能向量检索 + 根据反馈自动改写规则
- 分镜时间线编辑与整片拼接（ffmpeg concat + 转场）
- 参考视频音频复用 / 对白驱动口型
- 图片模型参考图编辑（角色一致性更强）
- 风格包浏览、对比与增量合并
- 成片质检（首尾帧偏差、身份漂移、运镜幅度）
