// 极简前端国际化：字典 + 语言订阅。
// ACT: 语言只存 localStorage，不同步服务端；换设备需要各自选择一次。
const STORAGE_KEY = "styleloom.lang";

export const LANGS = ["zh", "en"] as const;
export type Lang = (typeof LANGS)[number];

type Dict = Record<string, string>;

const dictionaries: Record<Lang, Dict> = {
  zh: {
    "app.title": "StyleLoom · 视频学习与生成 Agent",
    "app.tagline": "从参考片学习，再用 MiniMax H3 生成",
    "app.engineChecking": "检查配置…",
    "app.engineConfigured": "已配置：{flags}",
    "app.engineNotConfigured": "尚未配置模型",
    "app.engineLocalH3": "本地H3",
    "app.engineImage": "图片",

    "nav.projects": "项目",
    "nav.newProject": "新建项目",
    "nav.stylePacks": "风格包",
    "nav.noProjects": "还没有项目",
    "nav.noPacks": "学习参考片后自动生成",
    "nav.packHint": "对 Agent 说：套用风格包 {id}",
    "nav.noCharacters": "无角色",
    "nav.projectCreated": "创建 {time}",
    "nav.projectUpdated": "更新 {time}",
    "nav.renameProject": "重命名",
    "nav.deleteProject": "删除项目",
    "nav.renamePromptTitle": "项目名称",
    "nav.deleteConfirm": "确定删除项目「{title}」？本地素材与对话会一并删除，且不可恢复。",

    "chat.emptyTitle": "先给一个参考片，或者直接说想法",
    "chat.emptyExample": "例：学习 <code>/Users/you/Movies/reference.mp4</code> 的运镜和光线，做一个 8 秒的雨夜街头镜头。",
    "chat.emptyXhs": "也可以直接粘贴小红书笔记链接（带 xsec_token 的完整 URL），我会先下载再拉片。",
    "chat.emptyFlow": "学习流程：ffmpeg 切片 → 视觉模型逐镜头拉片 → 归纳定妆照、场景照、运镜与节奏 → H3 生成。",

    "composer.attachTitle": "上传参考图片或视频",
    "composer.placeholder": "和 Agent 沟通：上传参考图/视频，或提供创作想法、修改意见…",
    "composer.hint": "Enter 发送 · Shift+Enter 换行 · 可拖入图片/视频作为参考 · 生成会产生 H3 费用，Agent 会先征得确认",
    "composer.send": "发送",
    "composer.generating": "生成中…",
    "composer.uploading": "上传中…",

    "settings.title": "设置",
    "settings.secretsHint": "密钥只保存在本机 <code>data/settings.json</code>。留空表示不配置。",
    "settings.llmSection": "语言 / 视觉模型",
    "settings.baseUrl": "请求地址",
    "settings.apiKey": "API Key",
    "settings.textModel": "文本模型",
    "settings.visionModel": "视觉模型",
    "settings.keepSecret": "留空或保持 ********",
    "settings.videoSection": "MiniMax H3 视频",
    "settings.videoProvider": "视频后端",
    "settings.textVideoModel": "文生/首尾帧模型",
    "settings.referenceModel": "参考模型",
    "settings.videoHint": "<code>icompify</code> 走远程接口，按次计费；<code>local</code> 走本地 GPU 网关，免费但占用显存，不需要 API Key。",
    "settings.localVideoSection": "本地视频网关（provider=local）",
    "settings.gatewayUrl": "网关地址",
    "settings.gatewayToken": "网关口令",
    "settings.shortEdge": "输出短边",
    "settings.localVideoHint": "网关需自行部署并实现 <code>/v1/jobs</code> 接口，见 <code>docs/local-gpu.md</code>。单 worker 串行，出图与出片不能同时跑；不支持尾帧、参考视频，ref2va 只用第 1 张参考图。",
    "settings.xhsSection": "小红书视频下载",
    "settings.ytdlpPath": "yt-dlp 路径",
    "settings.browserCookie": "浏览器 Cookie",
    "settings.referer": "Referer",
    "settings.xhsHint": "需要先在对应浏览器登录小红书；Safari 需要给终端完全磁盘访问权限。",
    "settings.placeholderBrowser": "chrome / safari / 留空",
    "settings.imageSection": "图片模型（定妆照 / 场景照，可选）",
    "settings.imageApi": "接口类型",
    "settings.model": "模型",
    "settings.size": "尺寸",
    "settings.imageHint": "接口类型填 <code>local</code> 只走本地 GPU；填 <code>auto</code> 优先可用后端，远程不可用/未配置时回退。本地免费，远程按张计费。",
    "settings.placeholderImageBaseUrl": "OpenAI 兼容 /v1 或 OpenRouter /v1",
    "settings.placeholderImageModel": "例如 qwen/qwen-image-2.1-turbo",
    "settings.placeholderImageSize": "2K 或 1344x768",
    "settings.localImageSection": "本地 GPU 出图（直连或 SSH，可选）",
    "settings.connectMode": "连接方式",
    "settings.sshHost": "SSH 主机",
    "settings.placeholderSshHost": "user@host（仅 ssh 模式需要）",
    "settings.sshBin": "SSH 命令",
    "settings.scpBin": "SCP 命令",
    "settings.pythonBin": "Python 路径",
    "settings.scriptPath": "脚本路径",
    "settings.workdir": "工作目录",
    "settings.steps": "去噪步数",
    "settings.vramMode": "显存模式",
    "settings.timeoutMs": "超时 ms",
    "settings.localImageHint": "<code>auto</code> 在本机同时存在脚本与 Python 时直连，否则按 SSH 主机走远端；<code>direct</code> 只在本机 spawn，不经过 SSH/scp。短边 768 = 16:9 输出约 1344×768。",

    "inspector.emptyProject": "选择或新建项目后，这里显示学习成果、分镜与素材。",
    "inspector.tabOverview": "概览",
    "inspector.tabShots": "分镜",
    "inspector.tabJobs": "渲染",
    "inspector.tabAssets": "素材",
    "inspector.tabSkills": "技能",
    "inspector.updatedAt": "最后更新 {time}",

    "brief.title": "需求",
    "brief.empty": "还没有记录需求",
    "brief.genre": "类型",
    "brief.aspectRatio": "画幅",
    "brief.duration": "目标时长",
    "brief.constraints": "约束",
    "brief.keep": "保留：{item}",
    "brief.avoid": "避免：{item}",

    "learning.title": "学习状态",
    "learning.doneWithWarning": "已完成 · 有提示",
    "learning.referenceShots": "参考镜头",
    "learning.noShots": "还没有参考镜头。",
    "learning.keyframeTitle": "{id} 关键帧",
    "learning.fallbackWarning": "风格归纳使用规则版回退；可重新学习或手动修正风格圣经。",

    "learningStatus.none": "未开始",
    "learningStatus.slicing": "切片中",
    "learningStatus.annotating": "逐镜分析中",
    "learningStatus.distilling": "归纳中",
    "learningStatus.done": "已完成",
    "learningStatus.failed": "失败",

    "stage.brief": "需求",
    "stage.study": "学习",
    "stage.plan": "分镜",
    "stage.generate": "生成",
    "stage.deliver": "交付",

    "bible.title": "风格圣经",
    "bible.empty": "还没有风格圣经。学习参考片后会自动生成角色、场景与运镜。",
    "bible.perShot": "{value}s/镜",
    "bible.characterChip": "角色 · {name}",
    "bible.locationChip": "场景 · {name}",
    "bible.charactersLocations": "角色与场景",
    "bible.cameraGrammar": "运镜语法",
    "bible.stylePrefix": "风格前缀",
    "bible.characterStill": "定妆照",
    "bible.locationStill": "场景照",

    "jobs.title": "渲染队列",
    "jobs.active": "{count} 个进行中",
    "jobs.count": "{count} 条",
    "jobs.empty": "空",
    "jobs.hint": "渲染在服务端后台跑，关掉页面也不会中断。这里不占对话气泡。",
    "jobs.emptyHint": "还没有渲染任务。在对话里确认后让 Agent 生成视频，进度会出现在这里。",
    "jobs.play": "播放",
    "jobs.resume": "恢复等待",
    "jobs.resuming": "恢复中…",
    "jobs.status.running": "渲染中",
    "jobs.status.done": "已完成",
    "jobs.status.failed": "失败",
    "jobs.status.pending": "待恢复",

    "plan.title": "分镜",
    "plan.empty": "还没有分镜。先在左侧对话里描述想法，让 Agent 规划镜头。",
    "plan.hint": "点击视频封面，在弹窗里播放。",
    "plan.previewAria": "弹窗预览 {id}",
    "plan.generating": "生成中…",
    "plan.notGenerated": "未生成",
    "plan.shortBadge": "短镜头",
    "plan.shortBadgeTitle": "低于 H3 常规下限 4 秒；默认 4 秒生成后裁剪",
    "plan.action": "镜头描述",
    "plan.prompt": "H3 提示词 · {mode}",
    "plan.viewJobs": "查看渲染队列",
    "plan.panelHint": "进度见右侧「渲染」面板",
    "plan.panelDone": "已转后台渲染，进度见右侧面板",
    "plan.skillsBound": "绑定 {count} 条技能",
    "plan.skillFeedback": "技能效果",
    "plan.skillFeedbackSaved": "已记录：{rating} · {count} 条技能",
    "plan.skillFeedbackChange": "修改",

    "assets.title": "素材",
    "assets.all": "全部",
    "assets.other": "其他",
    "assets.file": "文件",
    "assets.empty": "还没有素材。",
    "assets.emptyFilter": "没有这类素材。",
    "assets.showing": "显示最近 {visible} 个，共 {total} 个。",

    "skills.title": "技能库",
    "skills.emptyHint": "学习参考片后自动积累；生成后反馈效果会调整置信度。",
    "skills.hint": "按 生效 → 候选 排序；置信度按独立项目证据与真实反馈计算。",
    "skills.emptyFilter": "没有这个状态的技能。",
    "skills.showAll": "显示全部 {count} 条",
    "skills.collapse": "收起",
    "skills.evidenceTitle": "{name} · 证据",
    "skills.stats": "证据 {evidence} · 项目 {projects} · 使用 {used} · 好评 {good} / 一般 {mixed} / 差评 {bad}",
    "skills.needsFeedback": "待验证",
    "skills.needsFeedbackFilter": "待验证",
    "skills.searchPlaceholder": "搜索名称 / 标签 / 适用条件",
    "skills.kindAll": "全部类型",
    "skills.rateLabel": "反馈",
    "skills.rate.good": "好",
    "skills.rate.mixed": "一般",
    "skills.rate.bad": "差",
    "skills.rateSaved": "已记录：{rating}",
    "skills.rateChange": "修改",
    "skills.needProject": "请先打开一个项目，再给技能记反馈。",

    "tool.running": "运行中…",
    "tool.preparing": "准备中",
    "tool.done": "完成",
    "tool.failed": "失败",
    "tool.elapsed": "耗时 {time}",
    "tool.elapsedTitle": "工具执行耗时",
    "tool.update_brief": "记录需求",
    "tool.study_reference_video": "学习参考视频",
    "tool.read_style_bible": "读取风格圣经",
    "tool.read_learning_shots": "读取拉片明细",
    "tool.update_style_bible": "修正风格圣经",
    "tool.plan_shots": "写入分镜",
    "tool.build_shot_prompt": "编写 H3 提示词",
    "tool.generate_still": "生成定妆照 / 场景照",
    "tool.generate_shot": "生成视频",
    "tool.resume_shot": "恢复已提交任务",
    "tool.set_shot_references": "绑定参考素材",
    "tool.stitch_shots": "拼接成片",
    "tool.list_assets": "查看素材",
    "tool.list_style_packs": "查看风格包",
    "tool.apply_style_pack": "套用风格包",
    "tool.set_stage": "更新阶段",
    "tool.rename_project": "重命名项目",
    "tool.delete_project": "删除项目",
    "tool.download_xhs_video": "下载小红书视频",
    "tool.search_skills": "搜索技能",
    "tool.read_skill": "读取技能",
    "tool.extract_skills": "抽取技能",
    "tool.record_skill_outcome": "记录技能反馈",
    "tool.update_skill": "更新技能",
    "tool.merge_skills": "合并技能",
    "tool.review_skill_duplicates": "检查近义技能",
    "tool.export_skills": "导出公开技能",

    "shotStatus.planned": "待生成",
    "shotStatus.promptReady": "提示词就绪",
    "shotStatus.generating": "生成中",
    "shotStatus.done": "已完成",
    "shotStatus.pending": "待恢复",
    "shotStatus.failed": "失败",

    "skillStatus.all": "全部",
    "skillStatus.active": "生效",
    "skillStatus.candidate": "候选",
    "skillStatus.deprecated": "停用",

    "skillKind.camera": "运镜",
    "skillKind.lighting": "灯光",
    "skillKind.color": "色彩",
    "skillKind.composition": "构图",
    "skillKind.rhythm": "节奏",
    "skillKind.prompt": "提示词",
    "skillKind.sound": "声音",
    "skillKind.workflow": "流程",
    "skillKind.avoid": "避坑",

    "media.video": "视频",
    "media.audio": "音频",
    "media.image": "图片",
    "media.attachment": "附件",
    "media.openOriginal": "原文件 ↗",

    "errors.needProject": "请先新建或选择一个项目。",
    "errors.needProjectForUpload": "请先新建或选择一个项目，再上传素材。",
    "errors.onlyMedia": "只支持上传图片或视频。",
    "errors.tooManyUploads": "一次最多上传 {max} 个素材。",
    "errors.noAssetReturned": "服务端未返回素材",
    "errors.uploadFailed": "上传失败：{message}",
    "errors.uploadFailedShort": "上传失败",
    "errors.requestFailed": "请求失败：{message}",
    "errors.generic": "出错了：{message}",
    "errors.openProject": "打开项目失败：{message}",
    "errors.resumeFailed": "恢复失败：{message}",
    "errors.createProject": "创建项目失败：{message}",
    "errors.renameProject": "重命名失败：{message}",
    "errors.deleteProject": "删除项目失败：{message}",
    "errors.loadSettings": "读取设置失败：{message}",
    "errors.saveSettings": "保存设置失败：{message}",
    "errors.init": "初始化失败：{message}",

    "units.shots": "{count} 镜",
    "units.referenceShots": "参考镜头",
    "units.duration": "时长",
    "units.resolution": "分辨率",
    "units.seconds": "{value} 秒",
    "units.items": "{count} 条",
    "units.entries": "{count} 项",
    "units.count": "{count} 个",

    "misc.save": "保存",
    "misc.cancel": "取消",
    "misc.close": "关闭",
    "misc.listSeparator": "、",
    "misc.newProjectPromptTitle": "项目名称",
    "misc.newProjectDefaultTitle": "我的视频项目",
    "misc.uploading": "上传中…",
    "misc.removeUpload": "移除 {label}",
    "misc.projectMeta": "{stage} · {count} 镜 · {learning}",
  },
  en: {
    "app.title": "StyleLoom · Video Learning & Generation Agent",
    "app.tagline": "Learn from reference footage, then generate with MiniMax H3",
    "app.engineChecking": "Checking config…",
    "app.engineConfigured": "Configured: {flags}",
    "app.engineNotConfigured": "No models configured",
    "app.engineLocalH3": "Local H3",
    "app.engineImage": "Image",

    "nav.projects": "Projects",
    "nav.newProject": "New project",
    "nav.stylePacks": "Style packs",
    "nav.noProjects": "No projects yet",
    "nav.noPacks": "Created automatically after studying a reference",
    "nav.packHint": "Ask the agent to apply style pack {id}",
    "nav.noCharacters": "No characters",
    "nav.projectCreated": "Created {time}",
    "nav.projectUpdated": "Updated {time}",
    "nav.renameProject": "Rename",
    "nav.deleteProject": "Delete project",
    "nav.renamePromptTitle": "Project name",
    "nav.deleteConfirm": "Delete project “{title}”? Local media and chat history will be removed permanently.",

    "chat.emptyTitle": "Start with a reference clip, or just describe an idea",
    "chat.emptyExample": "e.g. Study the camera moves and lighting of <code>/Users/you/Movies/reference.mp4</code> and make an 8-second rainy-night street shot.",
    "chat.emptyXhs": "You can also paste a Xiaohongshu note URL (the full URL including xsec_token); I'll download it first, then break it down.",
    "chat.emptyFlow": "Learning flow: ffmpeg slicing → vision model shot-by-shot breakdown → distill stills, locations, camera grammar and rhythm → H3 generation.",

    "composer.attachTitle": "Upload a reference image or video",
    "composer.placeholder": "Talk to the agent: upload reference images/videos, or share ideas and revision notes…",
    "composer.hint": "Enter to send · Shift+Enter for a new line · Drag in images/videos as references · Generation costs H3 credits, the agent asks first",
    "composer.send": "Send",
    "composer.generating": "Generating…",
    "composer.uploading": "Uploading…",

    "settings.title": "Settings",
    "settings.secretsHint": "Secrets are stored only on this machine in <code>data/settings.json</code>. Leave blank to skip.",
    "settings.llmSection": "Language / vision models",
    "settings.baseUrl": "Base URL",
    "settings.apiKey": "API Key",
    "settings.textModel": "Text model",
    "settings.visionModel": "Vision model",
    "settings.keepSecret": "Leave blank or keep ********",
    "settings.videoSection": "MiniMax H3 video",
    "settings.videoProvider": "Video backend",
    "settings.textVideoModel": "Text / first-last frame model",
    "settings.referenceModel": "Reference model",
    "settings.videoHint": "<code>icompify</code> uses the remote API and is billed per job; <code>local</code> uses the local GPU gateway, free but occupies VRAM, and needs no API Key.",
    "settings.localVideoSection": "Local video gateway (provider=local)",
    "settings.gatewayUrl": "Gateway URL",
    "settings.gatewayToken": "Gateway token",
    "settings.shortEdge": "Output short edge",
    "settings.localVideoHint": "Deploy the gateway yourself and implement the <code>/v1/jobs</code> API, see <code>docs/local-gpu.md</code>. A single worker runs jobs serially, so images and videos cannot run together; last frame and reference video are unsupported, and ref2va uses only the first reference image.",
    "settings.xhsSection": "Xiaohongshu video download",
    "settings.ytdlpPath": "yt-dlp path",
    "settings.browserCookie": "Browser cookies",
    "settings.referer": "Referer",
    "settings.xhsHint": "Sign in to Xiaohongshu in that browser first; Safari requires Full Disk Access for the terminal.",
    "settings.placeholderBrowser": "chrome / safari / blank",
    "settings.imageSection": "Image model (stills, optional)",
    "settings.imageApi": "API type",
    "settings.model": "Model",
    "settings.size": "Size",
    "settings.imageHint": "Set the API type to <code>local</code> to use only the local GPU; <code>auto</code> prefers an available backend and falls back when remote is unavailable or unconfigured. Local is free, remote is billed per image.",
    "settings.placeholderImageBaseUrl": "OpenAI-compatible /v1 or OpenRouter /v1",
    "settings.placeholderImageModel": "e.g. qwen/qwen-image-2.1-turbo",
    "settings.placeholderImageSize": "2K or 1344x768",
    "settings.localImageSection": "Local GPU images (direct or SSH, optional)",
    "settings.connectMode": "Connection",
    "settings.sshHost": "SSH host",
    "settings.placeholderSshHost": "user@host (only needed for ssh mode)",
    "settings.sshBin": "SSH command",
    "settings.scpBin": "SCP command",
    "settings.pythonBin": "Python path",
    "settings.scriptPath": "Script path",
    "settings.workdir": "Working directory",
    "settings.steps": "Denoise steps",
    "settings.vramMode": "VRAM mode",
    "settings.timeoutMs": "Timeout ms",
    "settings.localImageHint": "With <code>auto</code>, it runs directly when both the script and Python exist locally, otherwise it uses the SSH host; <code>direct</code> only spawns locally without SSH/scp. A short edge of 768 gives about 1344×768 at 16:9.",

    "inspector.emptyProject": "Select or create a project to see learning results, shots and assets here.",
    "inspector.tabOverview": "Overview",
    "inspector.tabShots": "Shots",
    "inspector.tabJobs": "Render",
    "inspector.tabAssets": "Assets",
    "inspector.tabSkills": "Skills",
    "inspector.updatedAt": "Updated {time}",

    "brief.title": "Brief",
    "brief.empty": "No brief recorded yet",
    "brief.genre": "Genre",
    "brief.aspectRatio": "Aspect ratio",
    "brief.duration": "Target length",
    "brief.constraints": "Constraints",
    "brief.keep": "Keep: {item}",
    "brief.avoid": "Avoid: {item}",

    "learning.title": "Learning",
    "learning.doneWithWarning": "Done · with notice",
    "learning.referenceShots": "Reference shots",
    "learning.noShots": "No reference shots yet.",
    "learning.keyframeTitle": "{id} keyframe",
    "learning.fallbackWarning": "Style distillation fell back to the rule-based path; re-run learning or edit the style bible manually.",

    "learningStatus.none": "Not started",
    "learningStatus.slicing": "Slicing",
    "learningStatus.annotating": "Analyzing shots",
    "learningStatus.distilling": "Distilling",
    "learningStatus.done": "Done",
    "learningStatus.failed": "Failed",

    "stage.brief": "Brief",
    "stage.study": "Study",
    "stage.plan": "Storyboard",
    "stage.generate": "Generate",
    "stage.deliver": "Deliver",

    "bible.title": "Style bible",
    "bible.empty": "No style bible yet. Characters, locations and camera moves are generated after learning a reference.",
    "bible.perShot": "{value}s/shot",
    "bible.characterChip": "Character · {name}",
    "bible.locationChip": "Location · {name}",
    "bible.charactersLocations": "Characters & locations",
    "bible.cameraGrammar": "Camera grammar",
    "bible.stylePrefix": "Style prefix",
    "bible.characterStill": "Character still",
    "bible.locationStill": "Location still",

    "jobs.title": "Render queue",
    "jobs.active": "{count} running",
    "jobs.count": "{count} jobs",
    "jobs.count#one": "{count} job",
    "jobs.empty": "Empty",
    "jobs.hint": "Rendering runs in the background on the server and survives a page reload. It doesn't take up chat bubbles.",
    "jobs.emptyHint": "No render jobs yet. Confirm in the chat and ask the agent to generate a video; progress shows up here.",
    "jobs.play": "Play",
    "jobs.resume": "Resume wait",
    "jobs.resuming": "Resuming…",
    "jobs.status.running": "Rendering",
    "jobs.status.done": "Done",
    "jobs.status.failed": "Failed",
    "jobs.status.pending": "Pending resume",

    "plan.title": "Shots",
    "plan.empty": "No shots yet. Describe your idea in the chat on the left and let the agent plan the shots.",
    "plan.hint": "Click a video cover to play it in the dialog.",
    "plan.previewAria": "Preview {id} in dialog",
    "plan.generating": "Generating…",
    "plan.notGenerated": "Not generated",
    "plan.shortBadge": "Short shot",
    "plan.shortBadgeTitle": "Below H3's usual 4s minimum; generates at 4s then trims",
    "plan.action": "Shot description",
    "plan.prompt": "H3 prompt · {mode}",
    "plan.viewJobs": "View render queue",
    "plan.panelHint": "Progress is in the Render panel on the right",
    "plan.panelDone": "Moved to background rendering; progress is in the right panel",
    "plan.skillsBound": "{count} skills bound",
    "plan.skillFeedback": "Skill result",
    "plan.skillFeedbackSaved": "Saved: {rating} · {count} skills",
    "plan.skillFeedbackChange": "Change",

    "assets.title": "Assets",
    "assets.all": "All",
    "assets.other": "Other",
    "assets.file": "File",
    "assets.empty": "No assets yet.",
    "assets.emptyFilter": "No assets of this type.",
    "assets.showing": "Showing latest {visible} of {total}.",

    "skills.title": "Skill library",
    "skills.emptyHint": "Accumulated from studied references; post-generation feedback adjusts confidence.",
    "skills.hint": "Sorted active → candidate; confidence uses unique-project evidence and real feedback.",
    "skills.emptyFilter": "No skills with this status.",
    "skills.showAll": "Show all {count}",
    "skills.collapse": "Collapse",
    "skills.evidenceTitle": "{name} · evidence",
    "skills.stats": "Evidence {evidence} · Projects {projects} · Used {used} · Good {good} / Mixed {mixed} / Bad {bad}",
    "skills.needsFeedback": "Needs feedback",
    "skills.needsFeedbackFilter": "Needs feedback",
    "skills.searchPlaceholder": "Search name / tags / applicability",
    "skills.kindAll": "All kinds",
    "skills.rateLabel": "Rate",
    "skills.rate.good": "Good",
    "skills.rate.mixed": "Mixed",
    "skills.rate.bad": "Bad",
    "skills.rateSaved": "Saved: {rating}",
    "skills.rateChange": "Change",
    "skills.needProject": "Open a project before rating a skill.",

    "tool.running": "Running…",
    "tool.preparing": "Preparing",
    "tool.done": "Done",
    "tool.failed": "Failed",
    "tool.elapsed": "Took {time}",
    "tool.elapsedTitle": "Tool execution time",
    "tool.update_brief": "Record brief",
    "tool.study_reference_video": "Study reference video",
    "tool.read_style_bible": "Read style bible",
    "tool.read_learning_shots": "Read shot breakdown",
    "tool.update_style_bible": "Update style bible",
    "tool.plan_shots": "Write shot plan",
    "tool.build_shot_prompt": "Write H3 prompt",
    "tool.generate_still": "Generate stills",
    "tool.generate_shot": "Generate video",
    "tool.resume_shot": "Resume submitted job",
    "tool.set_shot_references": "Bind reference assets",
    "tool.stitch_shots": "Stitch final cut",
    "tool.list_assets": "List assets",
    "tool.list_style_packs": "List style packs",
    "tool.apply_style_pack": "Apply style pack",
    "tool.set_stage": "Update stage",
    "tool.rename_project": "Rename project",
    "tool.delete_project": "Delete project",
    "tool.download_xhs_video": "Download Xiaohongshu video",
    "tool.search_skills": "Search skills",
    "tool.read_skill": "Read skill",
    "tool.extract_skills": "Extract skills",
    "tool.record_skill_outcome": "Record skill outcome",
    "tool.update_skill": "Update skill",
    "tool.merge_skills": "Merge skills",
    "tool.review_skill_duplicates": "Review near-duplicate skills",
    "tool.export_skills": "Export public skill",

    "shotStatus.planned": "Planned",
    "shotStatus.promptReady": "Prompt ready",
    "shotStatus.generating": "Generating",
    "shotStatus.done": "Done",
    "shotStatus.pending": "Pending resume",
    "shotStatus.failed": "Failed",

    "skillStatus.all": "All",
    "skillStatus.active": "Active",
    "skillStatus.candidate": "Candidate",
    "skillStatus.deprecated": "Deprecated",

    "skillKind.camera": "Camera",
    "skillKind.lighting": "Lighting",
    "skillKind.color": "Color",
    "skillKind.composition": "Composition",
    "skillKind.rhythm": "Rhythm",
    "skillKind.prompt": "Prompt",
    "skillKind.sound": "Sound",
    "skillKind.workflow": "Workflow",
    "skillKind.avoid": "Pitfalls",

    "media.video": "Video",
    "media.audio": "Audio",
    "media.image": "Image",
    "media.attachment": "Attachment",
    "media.openOriginal": "Original file ↗",

    "errors.needProject": "Create or select a project first.",
    "errors.needProjectForUpload": "Create or select a project before uploading assets.",
    "errors.onlyMedia": "Only images and videos can be uploaded.",
    "errors.tooManyUploads": "Upload at most {max} assets at once.",
    "errors.noAssetReturned": "The server did not return the asset",
    "errors.uploadFailed": "Upload failed: {message}",
    "errors.uploadFailedShort": "Upload failed",
    "errors.requestFailed": "Request failed: {message}",
    "errors.generic": "Something went wrong: {message}",
    "errors.openProject": "Failed to open project: {message}",
    "errors.resumeFailed": "Failed to resume: {message}",
    "errors.createProject": "Failed to create project: {message}",
    "errors.renameProject": "Failed to rename project: {message}",
    "errors.deleteProject": "Failed to delete project: {message}",
    "errors.loadSettings": "Failed to load settings: {message}",
    "errors.saveSettings": "Failed to save settings: {message}",
    "errors.init": "Initialization failed: {message}",

    "units.shots": "{count} shots",
    "units.shots#one": "{count} shot",
    "units.referenceShots": "Reference shots",
    "units.duration": "Duration",
    "units.resolution": "Resolution",
    "units.seconds": "{value}s",
    "units.items": "{count} items",
    "units.items#one": "{count} item",
    "units.entries": "{count} items",
    "units.entries#one": "{count} item",
    "units.count": "{count}",

    "misc.save": "Save",
    "misc.cancel": "Cancel",
    "misc.close": "Close",
    "misc.listSeparator": ", ",
    "misc.newProjectPromptTitle": "Project name",
    "misc.newProjectDefaultTitle": "My video project",
    "misc.uploading": "Uploading…",
    "misc.removeUpload": "Remove {label}",
    "misc.projectMeta": "{stage} · {count} shots · {learning}",
    "misc.projectMeta#one": "{stage} · {count} shot · {learning}",
  },
};

let current: Lang = "zh";
const listeners = new Set<(lang: Lang) => void>();

function normalizeLang(value: unknown): Lang | null {
  const text = String(value ?? "").trim().toLowerCase();
  if (text.startsWith("en")) return "en";
  if (text.startsWith("zh")) return "zh";
  return null;
}

function readStoredLang() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function syncDocument() {
  document.documentElement.lang = current === "en" ? "en" : "zh-CN";
  document.title = t("app.title");
}

export function getLang() {
  return current;
}

export function setLang(lang: unknown) {
  const next = normalizeLang(lang);
  if (!next) return current;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, current);
  } catch {
    // 隐私模式下 localStorage 可能不可写，忽略即可，本次会话仍然生效。
  }
  syncDocument();
  for (const listener of listeners) {
    try {
      listener(current);
    } catch (error) {
      console.warn(error);
    }
  }
  return current;
}

export function initLang() {
  const stored = normalizeLang(readStoredLang());
  const browser = typeof navigator !== "undefined" ? String(navigator.language || "").toLowerCase() : "";
  current = stored || (browser.startsWith("en") ? "en" : "zh");
  syncDocument();
  return current;
}

export function t(key: string, vars?: Record<string, unknown>) {
  const dict = dictionaries[current] || dictionaries.zh;
  // 英文单复数：可选 key#one 覆盖，count 为 1 时优先使用（中文不需要，直接省略）。
  const singular = vars && Number(vars.count) === 1 ? `${key}#one` : null;
  let template = singular ? dict[singular] ?? dictionaries.zh[singular] : null;
  if (template == null) template = dict[key];
  if (template == null) template = dictionaries.zh[key];
  if (template == null) return key;
  if (!vars) return template;
  return String(template).replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

export function subscribeLang(fn: (lang: Lang) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function langLocale() {
  return current === "en" ? "en-US" : "zh-CN";
}
