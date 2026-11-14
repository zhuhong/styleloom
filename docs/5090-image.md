# 接入 5090 本地 Qwen-Image

本项目的 `generate_still` 除了远程 OpenAI / OpenRouter 图片接口，也可以直接调用局域网 **RTX 5090** 上的 **Qwen-Image-2.1-Turbo**。这条路径复用了 `../5090_H3` 里已经验证过的 `remote/qwen_image_gen2.py`。

## 为什么走 SSH，而不是再写一套推理服务

- 5090 上的脚本已经支持批量、多张条件图、`--vram offload`，且实测 1344×768 / 8 步约 19–60 秒/张。
- 图片任务是低频操作，不值得为它常驻一个 Web 服务；SSH + scp 足够，失败也能直接看到远端 stderr。
- `../5090_H3/remote/diffsynthGateway.py` 的 HTTP 网关更适合视频长任务与外部多客户端排队；本项目当前只需要「出一张图」，所以先用最薄的 SSH 方案。以后要接网关，只需替换 `src/providers/image.ts` 的 local 分支。

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
| `image.local.host` | `5090`（或 `zhuh@192.168.0.121`） |
| `image.local.pythonBin` | `/home/zhuh/miniconda3/envs/diffsynth/bin/python` |
| `image.local.script` | `/home/zhuh/source_code/diffsynth_run/qwen_image_gen2.py` |
| `image.local.workdir` | `/home/zhuh/source_code/diffsynth_run` |
| `image.local.shortEdge` | `768`（16:9 → 1344×768；9:16 → 768×1344） |
| `image.local.steps` | `8` |
| `image.local.vram` | `offload`（32GB 最稳；`cuda` 可能 OOM） |

也可以用环境变量覆盖连接参数（不改 `data/settings.json`）：

```bash
IMAGEGEN_LOCAL_HOST=5090 \
IMAGEGEN_LOCAL_SCRIPT=/home/zhuh/source_code/diffsynth_run/qwen_image_gen2.py \
bun start
```

## 自检

只检查 SSH 与脚本，不加载模型、不占显存：

```bash
bun -e 'import { checkImageBackend } from "./src/providers/imageCheck"; console.log(await checkImageBackend())'
```

真正出一张图（会占用 5090，约 20–60 秒）：

```bash
bun -e 'import { probeLocalImage } from "./src/providers/imageCheck"; console.log(await probeLocalImage())'
```

## 条件图

`generate_still` 会从角色/场景的 `refImages`（学习阶段抽出的真实参考帧）优先取最多 3 张，找不到时再用已生成的 `stillImages`，通过 `qwen_image_gen2.py --ref` 传给 5090。这是 text-encoder 的 vision 条件通道，不做 img2img 加噪，所以人物、服装、背景能保留，只按 prompt 改姿态。

远程 OpenRouter 图片接口目前仍按文生图使用；只有 5090 本地后端会真正吃多张条件图。

## 已知限制

- 5090 上的 Qwen pipeline 加载约 31GB，首次/进程退出后首张会明显更慢；连续出图由远端脚本自己复用 pipeline 才有批量收益，本项目目前是「一张一进程」，所以每张都付加载成本。需要批量时优先在 5090 侧用 `--batch` 或接 `diffsynthGateway.py`。
- 运行期间独占显存；H3 与 Qwen 不要同时在这台 5090 上跑。
- 远端任务目录在 `remote_outputs/videocopy-<tag>/`，成功或失败后会自动 `rm -rf`；如果 SSH 中途断开，可能留下临时目录，可手动清理。
