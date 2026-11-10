# 小红书视频下载

Agent 支持把小红书笔记链接直接变成可学习的本地视频：展开短链 → `yt-dlp` 带浏览器登录态下载 → `ffprobe` 校验 → 复制进项目 `assets/sources/`。

## 前置

```bash
brew install yt-dlp        # 或 pipx install yt-dlp
```

- 需要在 **Chrome / Safari / Edge / Firefox** 里登录小红书。
- Safari 需要给终端「完全磁盘访问权限」，否则读不到 Cookie。
- Chrome 首次读取 Cookie 可能弹出 Keychain 授权，允许即可。

## 用法

### 对话里

直接粘贴链接或整段分享文案：

```
下载这个小红书视频：https://www.xiaohongshu.com/explore/66f0...?xsec_token=...&xsec_source=pc_feed
```

```
学这个链接的运镜：3 分钟学会低幅推镜 http://xhslink.com/a/xxxxx 复制本条信息...
```

Agent 会调用 `download_xhs_video`；也可以让它在学习时自动先下载：

```
学习这个小红书链接的运镜和光线，然后写一个 8 秒的会议室对话镜头
```

### 工具层

- `download_xhs_video { url }` → 返回 `localPath`、`relativePath`、标题、时长、警告。
- `study_reference_video { source }`：识别到小红书链接时自动下载，再走切片/拉片/技能抽取。

### 输出

- 原始下载：`data/cache/xhs/<noteId>-<时间>/`
- 项目副本：`data/projects/<id>/assets/sources/xhs-<noteId>.mp4`，并写入素材索引，网页可直接打开。

## 链接规则（重要）

1. **优先用浏览器地址栏的完整 URL**，必须带 `xsec_token`，例如：
   `https://www.xiaohongshu.com/explore/<id>?xsec_token=XXX&xsec_source=pc_feed`
2. `xhslink.com` 短链会被自动跟随展开；但短链本身没有 token，展开后也可能缺 token，失败时请回到浏览器复制完整地址。
3. 分享文案里夹带的链接会自动提取。
4. 私密、已删除、地区限制、仅粉丝可见的笔记无法下载。

## 配置

`data/settings.json`：

```json
"xhs": {
  "ytDlpPath": "yt-dlp",
  "cookiesFromBrowser": "chrome",
  "referer": "https://www.xiaohongshu.com",
  "userAgent": "Mozilla/5.0 ... Chrome/120.0.0.0 Safari/537.36",
  "timeoutMs": 300000
}
```

- `cookiesFromBrowser` 留空则不读取浏览器 Cookie（只适合公开笔记）。
- `ytDlpPath` 可填绝对路径，例如 `/opt/homebrew/bin/yt-dlp`。

网页右上角「设置 → 小红书视频下载」也能改这三项。

## 实际执行的命令

```bash
yt-dlp <完整笔记URL> \
  --cookies-from-browser chrome \
  --no-playlist --newline --progress \
  --socket-timeout 30 --retries 3 \
  --referer https://www.xiaohongshu.com \
  --user-agent "Mozilla/5.0 ..." \
  --format "bv*+ba/b" --merge-output-format mp4 \
  --no-simulate \
  --print "after_move:VIDEOCOPY_META\t%(title)s\t%(id)s\t%(filepath)s" \
  -o "data/cache/xhs/<noteId>-<时间>/%(id)s.%(ext)s"
```

下载进度会通过 SSE 实时显示；完成后用 `ffprobe` 读取时长/分辨率。

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| `No video formats found` | 链接缺 `xsec_token`、笔记是图文、或未登录；换浏览器地址栏完整 URL |
| `login / sign in / cookie` | 浏览器未登录，或 Cookie 读取失败；登录后重试，Safari 检查磁盘权限 |
| `Unsupported URL` | yt-dlp 版本旧；`brew upgrade yt-dlp` |
| `未找到 yt-dlp` | `brew install yt-dlp`，或在设置里填绝对路径 |
| 下载到的是图片/封面 | 该笔记没有视频；Agent 会返回标题和错误 |
| 频繁失败 | 小红书风控/限流；降低频率，换网络或稍后再试 |

## 边界与合规

- 不保存、不传输 Cookie；`yt-dlp` 直接读取本机浏览器。
- 只应用户要求下载；不要把他人视频直接当生成素材复刻身份，学习默认只借风格/运镜/美术。
- 下载内容版权归原作者，商用前自行确认授权。
- 笔记结构变化可能导致 yt-dlp 失效，更新 yt-dlp 通常即可。
