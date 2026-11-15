# 接入 5090 本地 H3 视频

`generate_shot` 默认走 icompify 远程接口。把 `video.provider` 设为 `local` 后，改为调用本机 **RTX 5090** 上的 `diffsynth_run/diffsynthGateway.py`，由网关串行调度 `h3_workflow.py` / `h3_ref2va_fast.py`。本地出片免费，但会占用显存并排队。

## 架构

```
styleloom (src/providers/video/local.ts)
  → POST   /v1/jobs            提交任务（prompt + base64 参考图 + 宽高/时长）
  → GET    /v1/jobs/{id}       轮询 status / progress / log
  → GET    /v1/jobs/{id}/file  下载 mp4
  → DELETE /v1/jobs/{id}       客户端取消时终止子进程

diffsynthGateway.py (单 worker 串行)
  → h3_workflow.py       t2v / fl2va
  → h3_ref2va_fast.py    ref2va（8 步 turbo LoRA）
```

网关每次生成起独立子进程，显存随进程退出回收。H3 约 30G 显存，**不能和 Qwen 出图同时跑**。

## 启动网关

```bash
/home/zhuh/miniconda3/envs/diffsynth/bin/python \
  /home/zhuh/source_code/diffsynth_run/diffsynthGateway.py --port 8000
```

需要口令时加 `--token <口令>`（或设 `DIFFSYNTH_GATEWAY_TOKEN`），本机设置里填同样的 `video.local.token`。

## 本机配置

网页「设置 → MiniMax H3 视频 / 5090 视频网关」：

| 字段 | 值 |
| --- | --- |
| `video.provider` | `local` |
| `video.local.baseUrl` | `http://127.0.0.1:8000` |
| `video.local.token` | 网关 `--token` 的值；未启用口令就留空 |
| `video.local.shortEdge` | `480`（16:9 → 832×480；长边按画幅推算并对齐 32） |

`video.provider=local` 时不再使用 `video.apiKey`、`video.model`、`video.referenceModel`。时长仍由分镜决定（1–15 秒），低于 4 秒默认按 4 秒生成后本地裁剪。

## 模式映射与能力边界

| 参考素材 | 网关 model | task | 说明 |
| --- | --- | --- | --- |
| 无首帧、无参考图 | `h3T2v` | `t2va` | 纯文本，网关默认 20 步 |
| 只有首帧 | `h3Fl2va` | `i2va` | 只锁首帧 |
| 有参考图、无首尾帧 | `h3Ref2va` | `ref2va` | 8 步 turbo，**只用第 1 张**参考图 |

以下情况会直接报错，需要改回 icompify 或调整素材：

- **尾帧**：网关的 `h3Fl2va` 没有尾帧位，FL2VA / L2VA 不支持。
- **参考视频**：网关没有参考视频通道。

`ref2va` 传入多张参考图时不会失败，但只会使用第 1 张；降级说明会写入资产 `meta.providerNotes`，并在进度里可见。脚本固定 24fps，帧数按 `duration × 24` 经 17k+5 网格对齐。

## 自检

只打 health，不占显存：

```bash
curl -s http://127.0.0.1:8000/v1/health
bun -e 'import { checkLocalVideo } from "./src/providers/video/local"; console.log(await checkLocalVideo())'
```

真正生成一段 4 秒 480p 视频（会占用 5090，数分钟级）：

```bash
bun -e '
import { generateLocalVideoJob } from "./src/providers/video/local";
import { loadSettings } from "./src/config";
const settings = await loadSettings();
const r = await generateLocalVideoJob({ prompt: "a red apple on a white table, slow push in", durationSeconds: 4 }, settings);
console.log(r.model, r.bytes.length);
'
```

## 实测

2026-11-15，RTX 5090 / H3 NF4 / `h3T2v` / 832×480 / 4 秒 / 网关默认 20 步：

| 指标 | 结果 |
| --- | --- |
| 网关任务耗时 | 361s（含首任务冷启动加载） |
| 产物 | 6.67MB mp4 |
| 规格 | 832×480、24fps、带音轨，107 帧（4.46s，17k+5 对齐） |

同一天同机直连 Qwen 出图（1344×768 / 8 步）冷启动设备内 159s、端到端 182s；连续出图会快于首次。

## 已知限制

- 网关是单 worker 串行队列：同一时间只跑一个任务，H3 / Qwen 互斥。
- 客户端超过 120 秒不轮询，网关会按 lease 自动取消任务；本项目的轮询间隔取 `min(video.pollIntervalMs, 5s)`，正常不会触发。
- H3 模型是 NF4 量化版；画质/速度与远程 icompify 的完整模型不完全一致。
- 网关重启会丢内存队列，但已落盘的产物保留 7 天。
