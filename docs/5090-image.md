# 接入 5090 本地 Qwen-Image

本项目的 `generate_still` 除了远程 OpenAI / OpenRouter 图片接口，也可以直接调用 **RTX 5090** 上的 **Qwen-Image-2.1-Turbo**。运行在 5090 本机时走**直连**（直接 `Bun.spawn` 脚本）；从别的机器用时走 **SSH**。两条路径复用已在本机验证过的 `diffsynth_run/qwen_image_gen2.py`。

## 连接方式

`image.local.mode` 决定怎么连 5090：

| 值 | 行为 |
| --- | --- |
| `auto`（默认） | 本机同时存在 `script` 与 `pythonBin` 就直连；否则只要 `host`、`script`、`pythonBin` 齐全就走 SSH |
| `direct` | 只在本机 `Bun.spawn`，不经过 SSH/scp；缺少脚本或 Python 直接报错 |
| `ssh` | 只走 SSH 远端，行为与旧版本一致 |

直连和 SSH 用的是同一套脚本参数，设备内出图耗时不变；直连省掉 SSH 连接、scp 上传条件图、拉回 PNG 与远端临时目录，端到端墙钟更短。

## 为什么不常驻一个推理服务

- 5090 上的脚本已经支持批量、多张条件图、`--vram offload`，且实测 1344×768 / 8 步约 19–60 秒/张。
- 图片任务是低频操作，不值得为它常驻一个 Web 服务；直连或 SSH 足够，失败也能直接看到脚本 stderr。
- `diffsynth_run/diffsynthGateway.py` 的 HTTP 网关更适合视频长任务与外部多客户端排队，视频侧已经接上（见 [5090-video.md](5090-video.md)）；图片仍保持「一张一进程」，需要批量时优先在 5090 侧用 `--batch`。

## 5090 侧准备

1. 部署出图脚本：

```bash
scp ../5090_H3/remote/qwen_image_gen2.py 5090:/home/zhuh/source_code/diffsynth_run/
```

2. 确认 Python 环境、模型和脚本可用：

```bash
ssh 5090 '/home/zhuh/miniconda3/envs/diffsynth/bin/python \
  /home/zhuh/source_code/diffsynth_run/qwen_image_gen2.py \
  -p "a red apple on a white table" -o /tmp/qwen-test.png --steps 8 --vram offload'
```

3. 确认本机免密登录：

```bash
ssh -o BatchMode=yes 5090 true && echo ok
```

如果 `ssh 5090` 被拒绝，先检查 5090 的 SSH 服务、`~/.ssh/config` 和公钥；本项目不会绕过 SSH 认证。

## 本机配置

在网页「设置 → 图片模型」里：

| 字段 | 值 |
| --- | --- |
| `image.api` | `local`（只走 5090）或 `auto`（优先 5090，不可达回退远程） |
| `image.local.mode` | `auto`（本机有脚本就直连，否则 SSH）/ `direct` / `ssh` |
| `image.local.host` | `5090`（或 `zhuh@192.168.0.121`）；直连模式不需要 |
| `image.local.pythonBin` | `/home/zhuh/miniconda3/envs/diffsynth/bin/python` |
| `image.local.script` | `/home/zhuh/source_code/diffsynth_run/qwen_image_gen2.py` |
| `image.local.workdir` | `/home/zhuh/source_code/diffsynth_run` |
| `image.local.shortEdge` | `768`（16:9 → 1344×768；9:16 → 768×1344） |
| `image.local.steps` | `8` |
| `image.local.vram` | `offload`（32GB 最稳；`cuda` 可能 OOM） |

也可以用环境变量覆盖连接参数（不改 `data/settings.json`）：

```bash
IMAGEGEN_LOCAL_MODE=direct \
IMAGEGEN_LOCAL_SCRIPT=/home/zhuh/source_code/diffsynth_run/qwen_image_gen2.py \
bun start
```

## 自检

`direct` 模式只查本机脚本与 Python 是否存在，`ssh` 模式只跑一条 `ssh true` 与 `test -f`；都不加载模型、不占显存：

```bash
bun -e 'import { checkImageBackend } from "./src/providers/imageCheck"; console.log(await checkImageBackend())'
```

真正出一张图（会占用 5090，约 20–60 秒）：

```bash
bun -e 'import { probeLocalImage } from "./src/providers/imageCheck"; console.log(await probeLocalImage())'
```

## 实测

2026-11-14，RTX 5090 / 1344×768 / 8 步 / `offload`：

| 输入 | 设备内耗时 | 端到端墙钟 | 产物 |
| --- | --- | --- | --- |
| 纯文生 | 38.8s | 70.8s | 1.4MB PNG |
| 1 张条件图 | 42.2s | 58.8s | 1.2MB PNG |

端到端包含 SSH 建目录、scp 上传/下载与远端进程启动；GPU 显存回到约 655MiB 基线。

2026-11-15 本机 `mode=direct` 复测：1344×768 / 8 步，冷启动设备内 159s、端到端 182s，产物 1.03MB PNG。直连不再有 SSH/scp 开销，但首次仍要付 pipeline 加载成本。

## 条件图

`generate_still` 会从角色/场景的 `refImages`（学习阶段抽出的真实参考帧）优先取最多 3 张，找不到时再用已生成的 `stillImages`，通过 `qwen_image_gen2.py --ref` 传给 5090。这是 text-encoder 的 vision 条件通道，不做 img2img 加噪，所以人物、服装、背景能保留，只按 prompt 改姿态。

远程 OpenRouter 图片接口目前仍按文生图使用；只有 5090 本地后端会真正吃多张条件图。

## 已知限制

- 5090 上的 Qwen pipeline 加载约 31GB，首次/进程退出后首张会明显更慢；连续出图由远端脚本自己复用 pipeline 才有批量收益，本项目目前是「一张一进程」，所以每张都付加载成本。需要批量时优先在 5090 侧用 `--batch` 或接 `diffsynthGateway.py`。
- 运行期间独占显存；H3 与 Qwen 不要同时在这台 5090 上跑。
- 远端任务目录在 `remote_outputs/videocopy-<tag>/`，成功或失败后会自动 `rm -rf`；如果 SSH 中途断开，可能留下临时目录，可手动清理。
