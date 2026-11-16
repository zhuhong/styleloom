# 部署配置指南

面向「把 StyleLoom 跑起来并长期用下去」的完整说明。只写已经验证过的命令与行为；没验证的会明确标注。

如果你只是想在开发机上跑一次看效果，看 [README 快速开始](../README.zh-CN.md) 就够了。本文覆盖：依赖自检、数据目录、后端选型、常驻运行、反向代理、备份与排错。

---

## 1. 前置条件

| 依赖 | 是否必需 | 用途 | 自检 |
| --- | --- | --- | --- |
| [Bun](https://bun.sh) 1.3+ | 必需 | 服务端与 CLI 运行时 | `bun --version` |
| `ffmpeg` / `ffprobe` | 必需（学习功能） | 切片、抽帧、拼接、裁剪 | `ffmpeg -version` |
| `yt-dlp` | 可选 | 小红书下载 | `yt-dlp --version` |
| OpenAI 兼容 LLM | 必需 | 对话与逐镜标注 | `curl $BASE_URL/models` |
| 支持视觉的模型 | 学习功能必需 | 逐镜拉片 | 同上 |
| icompify API Key | 与本地 GPU 二选一 | 云端 H3 出片 | 见 [第 4 节](#4-后端选型) |
| 本地 GPU（可选） | 可选 | 本地出图 / 出片，免费但占显存 | 见 [第 4 节](#4-后端选型) |

安装示例（macOS）：

```bash
brew install bun ffmpeg yt-dlp
```

Linux 用发行版包管理器装 `ffmpeg`，`bun` 与 `yt-dlp` 按官方脚本安装。

> `ffmpeg` 缺失时服务仍能启动，只在启动日志打一行 `[warn] 找不到 ffmpeg…`，学习与拼接会失败。这是实测行为，不是静默降级。

---

## 2. 最小可用部署

云端出片、不接本地 GPU 的最小路径：

```bash
git clone https://github.com/zhuhong/styleloom.git
cd styleloom
bun install

# 首次启动会自动创建 data/settings.json（内容是默认值）
bun start
# 打开 http://127.0.0.1:8787 → 右上「设置」填模型配置
```

也可以直接改文件：

```bash
mkdir -p data && cp settings.example.json data/settings.json
chmod 600 data/settings.json
```

必须填的字段：

| 字段 | 说明 |
| --- | --- |
| `llm.baseUrl` | OpenAI 兼容地址，例如 `http://localhost:4000/v1` |
| `llm.apiKey` | 该网关要求的 Key；本地网关可能允许为空 |
| `llm.model` | 支持 tool calling 的文本模型 |
| `llm.visionModel` | 支持图片输入的模型，逐镜拉片用 |
| `video.apiKey` | icompify Key，云端出片必需 |

其余字段按需调整：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `server.host` | `127.0.0.1` | 绑定地址；`0.0.0.0` 才会被局域网访问，见 [第 6 节](#6-局域网与反向代理) |
| `server.port` | `8787` | 端口；多实例时每个实例要不同 |
| `video.baseUrl` | `https://api.icompify.com` | icompify 地址 |
| `video.model` / `referenceModel` | `minimax-h3-fl2va` / `minimax-h3-ref2va` | 文生/首尾帧 与 参考模型 |
| `video.shortEdge` / `steps` | `768` / `50` | 云端输出短边与推理步数 |
| `video.pollIntervalMs` / `maxWaitMs` | `10000` / `7200000` | 轮询间隔与最长等待（120 分钟；超时后可用 `resume_shot` 接回，不重复计费） |
| `xhs.ytDlpPath` | `yt-dlp` | 二进制路径 |
| `xhs.cookiesFromBrowser` | `chrome` | `chrome` / `safari` / `firefox` / `edge` / 留空表示不读 Cookie |
| `xhs.referer` / `userAgent` / `timeoutMs` | 见示例文件 | 下载请求头与超时 |
| `ffmpeg.ffmpegPath` / `ffprobePath` | `ffmpeg` / `ffprobe` | 二进制路径，可写绝对路径 |
| `learning.sceneThreshold` | `0.32` | 切镜阈值，越低切点越多 |
| `learning.minShotSeconds` | `0.6` | 最短镜头，短于此的切点丢弃 |
| `learning.maxShots` | `40` | 上限；超过则退化为等分切片 |
| `learning.sampleCount` | `3` | 每镜送视觉模型的采样帧数（1–3） |
| `learning.keepClips` | `true` | 是否保留每镜 `clip.mp4`（关掉省磁盘，但 Ref2VA 参考片段不可用） |

`bun start` 输出会告诉你实际生效的路径，可用于确认部署是否正确：

```text
StyleLoom Agent: http://127.0.0.1:8787
数据目录: /Users/you/styleloom/data
设置文件: /Users/you/styleloom/data/settings.json
```

### 部署后冒烟清单

按顺序做完这四步，说明部署是通的：

```bash
# 1. 服务活着，并确认数据目录
curl -s http://127.0.0.1:8787/api/health
# {"ok":true,"dataDir":"/Users/you/styleloom/data"}

# 2. 设置能读回，且 Key 已打码
curl -s http://127.0.0.1:8787/api/settings | head -c 300
# apiKey 字段应显示 "********"

# 3. 项目列表可访问（空数组也算通过）
curl -s http://127.0.0.1:8787/api/projects

# 4. 图片后端自检（不加载模型、不计费）
bun -e 'import { checkImageBackend } from "./src/providers/imageCheck"; console.log(await checkImageBackend())'
```

然后在页面里新建项目，发一句「你好」确认 SSE 与 LLM 连通。**不要**在这一步就点生成，出片是计费操作。

---

## 3. 数据目录与隔离

所有运行数据都在 `data/`（git 忽略），结构如下：

```text
data/
├── settings.json          # 全部配置与密钥，建议 chmod 600
├── projects/<id>/          # 每个项目一个目录
│   ├── project.json       # brief / learning / styleBible / plan[] / assets[]
│   ├── session.json       # 对话历史（含上传附件）
│   ├── learning/          # slice.json、关键帧、采样、片段、styleBible
│   └── assets/            # sources / stills / videos / uploads
├── library/packs/          # 风格包（可跨项目套用）
├── skills/<id>/            # 全局技能 + evidence/ 证据图
└── cache/                 # 临时目录，可随时清
    ├── xhs/               # 小红书下载中间产物
    ├── stitch/            # 拼接临时文件
    ├── short-shots/       # 短镜头裁剪原始产物
    └── image/             # 本地 GPU 出图临时文件
```

生命周期与建议：

| 路径 | 能删吗 | 说明 |
| --- | --- | --- |
| `cache/` | 可以，随时 | 只是中间产物，删了下次重新生成 |
| `projects/` | 可以，但会丢项目 | 参考片、生成结果、对话历史都在这里 |
| `library/` | 建议备份 | 风格包是跨项目复用的资产 |
| `skills/` | **强烈建议备份** | 全局技能与证据图，删了就没了；这是长期资产 |
| `settings.json` | 不要删 | 删了会重建默认值，密钥全丢 |

### 多实例 / 换盘

唯一的数据目录开关是环境变量 `VIDEOCOPY_DATA`：

```bash
VIDEOCOPY_DATA=/Volumes/fast/styleloom-data bun start
```

它接受绝对路径，默认值是仓库下的 `data/`。同一台机器跑多个实例时，每个实例要同时指定不同的 `VIDEOCOPY_DATA` 和不同的 `server.port`：

```bash
VIDEOCOPY_DATA=/srv/styleloom-a bun start   # settings 里 port: 8787
VIDEOCOPY_DATA=/srv/styleloom-b bun start   # settings 里 port: 8788
```

注意 `server.port` 在 `settings.json` 里，不是环境变量。新建数据目录时首次启动会写入默认 `8787`，需要先改文件再启动，否则第二个实例会 `EADDRINUSE`。

---

## 4. 后端选型

两条独立的轴：**图片**和**视频**可以分别选远程或本地 GPU。

### 图片（定妆照 / 场景照）

| `image.api` | 行为 | 费用 |
| --- | --- | --- |
| `local` | 只用本地 GPU，不可用直接报错 | 免费 |
| `auto` | 本地 GPU 可用就用，否则回退远程 | 视情况 |
| `openrouter` / `openai` | 只用远程图片接口 | 按张计费 |
| 留空（未配 `baseUrl`/`model`） | 回退为参考片关键帧 | 免费 |

本地 GPU 的连法由 `image.local.mode` 决定：

| `mode` | 适用场景 |
| --- | --- |
| `auto` | 本机有脚本与 Python 就直连，否则走 SSH |
| `direct` | StyleLoom 与推理脚本在同一台机器，`Bun.spawn` 直连 |
| `ssh` | StyleLoom 在另一台机器，通过 SSH + scp 调远端脚本 |

### 视频（H3）

| `video.provider` | 行为 | 费用 |
| --- | --- | --- |
| `icompify`（默认） | 云端 H3，支持 T2VA / I2VA / FL2VA / L2VA / Ref2VA | 按次计费 |
| `local` | 本地网关，只支持 t2va / i2va / ref2va（单张参考图） | 免费，占显存 |

本地视频网关是单 worker 串行队列，**不能与本地出图同时跑**（H3 约 30G 显存，Qwen 约 31G）。

### 能力对照

| 能力 | icompify | 本地网关 |
| --- | --- | --- |
| 纯文本出片（T2VA） | ✅ | ✅ |
| 首帧出片（I2VA） | ✅ | ✅ |
| 首尾帧（FL2VA / L2VA） | ✅ | ❌ 直接报错 |
| 参考图（Ref2VA） | ✅ 多张 | ✅ 仅第 1 张 |
| 参考视频 | ✅ | ❌ 直接报错 |
| 短于 4 秒 | ✅ 实验档位 | 按 4 秒生成后裁剪 |

接本地 GPU 的完整配置见 [local-gpu.md](local-gpu.md)。

---

## 5. 常驻运行

`bun start` 是前台进程，关掉终端就停。长期使用选一种常驻方式。

### macOS（launchd）

创建 `~/Library/LaunchAgents/com.styleloom.agent.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.styleloom.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/you/.bun/bin/bun</string>
    <string>run</string>
    <string>/Users/you/styleloom/src/server.ts</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/you/styleloom</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>VIDEOCOPY_DATA</key><string>/Users/you/styleloom-data</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/Library/Logs/styleloom.log</string>
  <key>StandardErrorPath</key><string>/Users/you/Library/Logs/styleloom.err.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.styleloom.agent.plist
launchctl list | grep styleloom        # 确认在跑
launchctl unload ~/Library/LaunchAgents/com.styleloom.agent.plist   # 停止
```

`bun` 的绝对路径用 `which bun` 查。`launchd` 不读 shell 的 PATH，必须写全路径。

### Linux（systemd）

`/etc/systemd/system/styleloom.service`：

```ini
[Unit]
Description=StyleLoom video agent
After=network-online.target

[Service]
Type=simple
User=styleloom
WorkingDirectory=/srv/styleloom
Environment=VIDEOCOPY_DATA=/srv/styleloom-data
ExecStart=/home/styleloom/.bun/bin/bun run src/server.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now styleloom
sudo systemctl status styleloom
journalctl -u styleloom -f
```

### 前台调试

```bash
nohup bun start > styleloom.log 2>&1 &
echo $! > styleloom.pid
kill "$(cat styleloom.pid)"
```

`nohup` 方式不会自动重启，只适合临时验证。

---

## 6. 局域网与反向代理

默认只绑本机：

```json
"server": { "host": "127.0.0.1", "port": 8787 }
```

**没有任何应用层认证**，所以不要把 8787 直接暴露到公网。

### 让局域网访问

改 `data/settings.json`：

```json
"server": { "host": "0.0.0.0", "port": 8787 }
```

然后从其它机器访问 `http://<你的内网IP>:8787`。局域网内也建议至少加一层反向代理认证，因为任何能访问该端口的人都能读你的项目和素材。

### nginx 反代 + Basic Auth

```nginx
server {
  listen 443 ssl http2;
  server_name styleloom.example.com;

  ssl_certificate     /etc/letsencrypt/live/styleloom.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/styleloom.example.com/privkey.pem;

  client_max_body_size 200m;   # 上传限制：视频单文件 140MB

  auth_basic           "StyleLoom";
  auth_basic_user_file /etc/nginx/.htpasswd;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;

    # 聊天走 SSE：必须关掉缓冲，否则进度和消息会被攒住
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }
}
```

关键点：

- `client_max_body_size` 要大于视频上传上限（140MB），否则上传返回 413。
- SSE 必须 `proxy_buffering off`，后端已经发了 `X-Accel-Buffering: no`，但 nginx 侧也要关。
- `proxy_read_timeout` 要够长，H3 单镜可能跑几分钟。
- 认证放在反代层，应用本身没有登录。

生成口令文件：

```bash
htpasswd -c /etc/nginx/.htpasswd youruser
nginx -t && sudo systemctl reload nginx
```

---

## 7. 环境变量参考

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `VIDEOCOPY_DATA` | 数据目录绝对路径 | 仓库下 `data/` |
| `IMAGEGEN_LOCAL_MODE` | 本地图片后端连法：`auto` / `direct` / `ssh` | 取 `settings.json` |
| `IMAGEGEN_LOCAL_HOST` | SSH 主机别名或 `user@host` | 取 `settings.json` |
| `IMAGEGEN_LOCAL_SCRIPT` | 远端出图脚本绝对路径 | 取 `settings.json` |
| `IMAGEGEN_LOCAL_PYTHON` | 远端 Python 解释器路径 | 取 `settings.json` |
| `IMAGEGEN_LOCAL_WORKDIR` | 远端工作目录 | 取 `settings.json` |
| `IMAGEGEN_SSH_BIN` | SSH 可执行文件 | `ssh` |
| `IMAGEGEN_SCP_BIN` | SCP 可执行文件 | `scp` |

`IMAGEGEN_*` 只覆盖「连哪台机器 / 用哪种连法」，不写回 `settings.json`；进程退出即失效。适合临时切环境或写进 systemd 的 `Environment=`。

其余配置（端口、模型、密钥、学习参数）全部在 `data/settings.json`，没有环境变量覆盖入口。

---

## 8. 备份、清理与升级

### 备份

至少要备份两处，其它都可重建：

```bash
# 全局技能：长期资产，含证据图
tar -czf styleloom-skills-$(date +%F).tar.gz -C data skills

# 配置与密钥
cp data/settings.json settings.json.bak
```

项目目录（`data/projects/`）体积大（参考片、生成视频），按需备份；`library/` 是风格包，建议一起备份。

### 清理

```bash
# 中间产物，随时可删
rm -rf data/cache/*

# 单个项目的临时片段（保留关键帧与成片）
find data/projects/*/assets/sources -name "*.mp4" -delete
```

### 升级

```bash
git pull --ff-only
bun install
bun run typecheck
# 重启服务
```

升级前先备份 `data/settings.json` 与 `data/skills/`。本项目没有数据库迁移，但 `settings.json` 的结构会随版本新增字段；启动时 `normalizeSettings` 会补默认值，旧文件不会报错。

回滚：

```bash
git log --oneline -5
git checkout <上一个正常提交>
bun install
# 重启
```

`data/` 不受版本控制，回滚代码不会回滚数据；如果新版本改过数据结构，回滚后旧代码可能读不懂新字段，但 `normalizeStyleBible` / `normalizeSettings` 都做了兼容填充。

---

## 9. 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `EADDRINUSE` | 端口被占（常见于上次实例没退干净） | `lsof -ti tcp:8787 \| xargs kill`，或改 `server.port` |
| 启动日志 `[warn] 找不到 ffmpeg` | PATH 里没有 ffmpeg | 安装，或在 `ffmpeg.ffmpegPath` 写绝对路径 |
| 设置页保存后 Key 变成空 | 提交了非 `********` 的空值 | 重新填一次 Key；`********` 是「保留原值」的占位符 |
| `/api/settings` 返回的 Key 是 `********` | 正常，这是打码 | 不用处理 |
| 聊天一直没有输出 | 反代缓冲了 SSE | nginx 加 `proxy_buffering off` |
| 上传视频返回 413 | 反代 body 上限太小 | `client_max_body_size 200m` |
| 学习卡在「逐镜分析中」 | 视觉模型不可用或超时 | 检查 `llm.visionModel` 与网关连通性 |
| `generate_shot` 报「需要 confirmed=true」 | 设计如此，防止误计费 | 这是费用门槛，不是 bug |
| 小红书下载失败 | 未登录 / 链接缺 `xsec_token` / 笔记私密 | 见 [xhs-download.md](xhs-download.md) |
| 本地 GPU 图片自检报「未配置」 | `image.local` 的 `script`/`pythonBin` 为空 | 见 [local-gpu.md](local-gpu.md) |
| 本地视频网关不可用 | 网关没启动 | 见 [local-gpu.md](local-gpu.md) |

---

## 10. 安全清单

部署到非本机环境前，逐条确认：

- [ ] `data/settings.json` 权限是 `600`，只有运行用户可读
- [ ] `data/` 不在版本控制里（`git status` 看不到）
- [ ] `git config core.hooksPath .githooks` 已启用，`pre-commit` 会拦密钥
- [ ] 没有把 8787 直接暴露公网；要么只在内网，要么反代加认证
- [ ] 反代开了 HTTPS
- [ ] 反代关掉了缓冲（SSE 需要）
- [ ] 反代 body 上限大于 140MB（视频上传）
- [ ] 备份了 `data/skills/` 与 `data/settings.json`
- [ ] 知道 `data/cache/` 可以随时删
