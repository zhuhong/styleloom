# 接入本地 GPU（可选）

StyleLoom 默认走云端：图片走远程图片接口，视频走 icompify。如果你有自己的 GPU 机器，可以把**图片**和**视频**分别改成走本地，省钱但占显存。

本文不假设任何具体主机名或路径。仓库里所有 `image.local.*` 的默认值都是**空的**，请按自己的机器填写。

---

## 0. 需要你提供的东西

| 项目 | 说明 |
| --- | --- |
| 出图脚本 | 一个接受 `-p/-o/--width/--height/--steps/--vram/--ref` 的脚本，输出 PNG |
| 出图 Python | 该脚本可用的解释器绝对路径 |
| （可选）视频网关 | 一个 HTTP 网关，暴露 `/v1/jobs` 等接口，能力见第 4 节 |
| 连法 | StyleLoom 与脚本同机 → 直连；不同机 → SSH |

脚本契约（图片）：

```bash
<pythonBin> <script> \
  -p "<prompt>" -o "<out.png>" \
  --width 1344 --height 768 \
  --steps 8 --vram offload \
  [--ref <cond1.png> --ref <cond2.png> ...]
```

要求：成功时退出码 0 并写出 `out.png`；`--ref` 可重复，用于条件图。脚本内部怎么实现不限。

---

## 1. 图片后端

### 三种连法

`image.local.mode` 决定怎么连：

| 值 | 行为 |
| --- | --- |
| `auto`（默认） | 本机同时存在 `script` 与 `pythonBin` 就直连；否则只要 `host`、`script`、`pythonBin` 齐全就走 SSH |
| `direct` | 只在本机 `Bun.spawn`，不经过 SSH/scp；缺少脚本或 Python 直接报错 |
| `ssh` | 只走 SSH 远端 |

直连与 SSH 用同一套脚本参数，设备内耗时不变；直连省掉 SSH 连接、scp 上传条件图、拉回 PNG 与远端临时目录。

### 配置

`data/settings.json`：

```json
{
  "image": {
    "api": "local",
    "local": {
      "mode": "auto",
      "host": "",
      "pythonBin": "/path/to/your/python",
      "script": "/path/to/qwen_or_any_t2i.py",
      "workdir": "/path/to/workdir",
      "shortEdge": 768,
      "steps": 8,
      "vram": "offload",
      "timeoutMs": 900000
    }
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `api` | `local` 只用本地；`auto` 本地优先、不可用回退远程；`openrouter`/`openai` 只用远程 |
| `mode` | 见上表 |
| `host` | SSH 主机别名或 `user@host`；直连不需要 |
| `pythonBin` | 解释器路径。若只有命令名（如 `python3`）也可以，会用 `Bun.which` 解析 |
| `script` | 脚本绝对路径 |
| `workdir` | 脚本工作目录（有些脚本从 cwd 加载相对路径资源） |
| `shortEdge` | 输出短边，长边按画幅比例推算并对齐 32；16:9 时 `768 → 1344×768` |
| `steps` | 传给脚本的步数。注意：某些蒸馏 checkpoint 会忽略它（见第 5 节） |
| `vram` | 传给脚本的显存策略，取值由你自己的脚本定义 |
| `timeoutMs` | 单张超时 |

`shortEdge` 与画幅的换算：

| shortEdge | 16:9 | 9:16 |
| --- | --- | --- |
| 768 | 1344×768 | 768×1344 |
| 1024 | 1792×1024 | 1024×1792 |
| 1536 | 2720×1536 | 1536×2720 |

### 环境变量覆盖

只覆盖「连哪台机器 / 用哪种连法」，不写回配置文件：

```bash
IMAGEGEN_LOCAL_MODE=ssh \
IMAGEGEN_LOCAL_HOST=my-gpu-host \
IMAGEGEN_LOCAL_SCRIPT=/opt/t2i/generate.py \
IMAGEGEN_LOCAL_PYTHON=/opt/conda/envs/t2i/bin/python \
bun start
```

完整列表见 [deploy.md 第 7 节](deploy.md#7-环境变量参考)。

### 自检

`direct` 只查本机文件是否存在，`ssh` 只跑一条 `ssh true` 与 `test -f`；都不加载模型、不占显存、不计费：

```bash
bun -e 'import { checkImageBackend } from "./src/providers/imageCheck"; console.log(await checkImageBackend())'
```

真正出一张图（会占显存，分钟级）：

```bash
bun -e 'import { probeLocalImage } from "./src/providers/imageCheck"; console.log(await probeLocalImage())'
```

`probeLocalImage` 会强制走本地后端，不会在失败时静默回退到计费远程接口。

### 条件图怎么传

`generate_still` 会从角色/场景里取最多 3 张参考图，按顺序：

1. `refImages`（学习阶段从参考片抽的真实关键帧）
2. `stillImages`（已生成的定妆照）

有就通过 `--ref` 传给脚本。这是 text-encoder 的 vision 条件通道，不做 img2img 加噪，所以人物、服装、背景能保留，只按 prompt 改姿态。

远程图片接口（`openrouter` / `openai`）只按文生图使用，不吃条件图。

---

## 2. 视频后端

`video.provider=local` 时，`generate_shot` 改调本地 HTTP 网关，不再用 icompify。

网关需要提供：

```text
GET    /v1/health          存活、模型列表、队列
POST   /v1/jobs            提交任务 → { id }
GET    /v1/jobs/{id}       状态、progress、日志尾部
GET    /v1/jobs/{id}/file  下载产物
DELETE /v1/jobs/{id}       取消
```

提交体：

```json
{
  "model": "h3T2v | h3Fl2va | h3Ref2va",
  "prompt": "...",
  "refs": [{ "data": "<base64>", "mimeType": "image/png" }],
  "params": { "width": 832, "height": 480, "duration": 4, "steps": 20 }
}
```

### 配置

```json
{
  "video": {
    "provider": "local",
    "local": {
      "baseUrl": "http://127.0.0.1:8000",
      "token": "",
      "shortEdge": 480
    }
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `provider` | `icompify`（默认）或 `local` |
| `baseUrl` | 网关地址 |
| `token` | 网关启用了口令时填；会以 `X-Toonflow-Gateway-Token` 头发送 |
| `shortEdge` | 输出短边，`480 → 832×480`（16:9） |

`provider=local` 时不再读 `video.apiKey` / `video.model` / `video.referenceModel`。时长仍由分镜决定（1–15 秒），低于 4 秒默认按 4 秒生成后本地裁剪。

### 模式映射与能力边界

| 参考素材 | 网关 model | task | 说明 |
| --- | --- | --- | --- |
| 无首帧、无参考图 | `h3T2v` | `t2va` | 纯文本 |
| 只有首帧 | `h3Fl2va` | `i2va` | 只锁首帧 |
| 有参考图、无首尾帧 | `h3Ref2va` | `ref2va` | **只用第 1 张**参考图 |

以下情况直接报错，需要改回 `icompify` 或调整素材：

- **尾帧**：本地路径没有尾帧位，FL2VA / L2VA 不支持。
- **参考视频**：本地路径没有参考视频通道。

`ref2va` 传多张参考图时不会失败，但只用第 1 张；降级说明会写进资产 `meta.providerNotes`，进度里也可见。

### 自检

只打 health，不占显存：

```bash
curl -s http://127.0.0.1:8000/v1/health
bun -e 'import { checkLocalVideo } from "./src/providers/video/local"; console.log(await checkLocalVideo())'
```

---

## 3. 显存互斥

本地视频（H3）与本地出图（Qwen 一类）都会独占显存，**不能同时跑**。具体数值取决于你的模型量化档位，实测中 H3 NF4 约 30G、Qwen bf16 约 31G，32G 卡上二者互斥。

网关本身是单 worker 串行队列，同一时间只跑一个任务。图片路径是「一张一进程」，不排队，所以图片与视频争抢显存时需要你自己错开。

---

## 4. 部署清单

从零接一台 GPU 机器：

1. 在 GPU 机器上放好出图脚本，确认能独立跑通：

   ```bash
   <pythonBin> <script> -p "a red apple" -o /tmp/t.png --width 1344 --height 768 --steps 8
   ```

2. 决定连法：

   - 同机 → `mode: "direct"`
   - 跨机 → 配好免密登录，`ssh -o BatchMode=yes <host> true` 返回 0

3. 填 `data/settings.json` 的 `image.local.*`，跑 `checkImageBackend`，再跑 `probeLocalImage`。

4. 要本地出片的话，启动网关，填 `video.local.*`，跑 `checkLocalVideo`。

5. 切 `image.api` / `video.provider`，先做一个小镜头验证，再上正式项目。

---

## 5. 图片质量与步数

如果你的出图脚本用的是蒸馏 Turbo checkpoint，**它可能忽略 `--steps`**。

例：`Qwen-Image-2.1-Turbo` 的模型卡写明它固定用内嵌的 8 步 schedule，`num_inference_steps` 不生效；要改只能显式传 `sigmas`，而官方未评估其他 schedule。这种情况下提高 `steps` 不会改善画质，应该先提高 `shortEdge`。

判断方法：看 checkpoint 目录里有没有内嵌采样 schedule（如 `model_index.json` 的 `sample_sigmas`），或直接读模型卡。

---

## 6. 已知限制

- 图片路径是「一张一进程」：每次都要重新加载模型，冷启动明显慢于连续出图。批量出图请在 GPU 侧自己用批量模式，或把图片也接到网关那类常驻队列上（本项目暂未实现）。
- SSH 路径的远端临时目录在 `remote_outputs/` 下，成功或失败后会自动删除；SSH 中途断开可能留下残留目录，需手动清理。
- 本地网关不支持尾帧与参考视频，需要这些能力时必须用 `icompify`。
- 本地产物码率、色彩与云端不保证一致。
