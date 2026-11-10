const state = {
  projects: [],
  packs: [],
  skills: [],
  project: null,
  shots: [],
  settings: null,
  streaming: false,
  toolCards: new Map(),
  refreshTimer: null,
  inspectorTab: null,
  assetFilter: "all",
  skillFilter: "all",
  showAllSkills: false,
};

const els = {
  projectList: document.getElementById("projectList"),
  packList: document.getElementById("packList"),
  messages: document.getElementById("messages"),
  inspector: document.getElementById("inspector"),
  input: document.getElementById("input"),
  composer: document.getElementById("composer"),
  sendButton: document.getElementById("sendButton"),
  newProjectButton: document.getElementById("newProjectButton"),
  settingsButton: document.getElementById("settingsButton"),
  settingsDialog: document.getElementById("settingsDialog"),
  settingsForm: document.getElementById("settingsForm"),
  mediaDialog: document.getElementById("mediaDialog"),
  mediaDialogTitle: document.getElementById("mediaDialogTitle"),
  mediaDialogOpen: document.getElementById("mediaDialogOpen"),
  mediaDialogClose: document.getElementById("mediaDialogClose"),
  mediaDialogImage: document.getElementById("mediaDialogImage"),
  mediaDialogVideo: document.getElementById("mediaDialogVideo"),
  mediaDialogAudio: document.getElementById("mediaDialogAudio"),
  engineState: document.getElementById("engineState"),
};

const toolLabels = {
  update_brief: "记录需求",
  study_reference_video: "学习参考视频",
  read_style_bible: "读取风格圣经",
  read_learning_shots: "读取拉片明细",
  update_style_bible: "修正风格圣经",
  plan_shots: "写入分镜",
  build_shot_prompt: "编写 H3 提示词",
  generate_still: "生成定妆照 / 场景照",
  generate_shot: "生成视频",
  stitch_shots: "拼接成片",
  list_assets: "查看素材",
  list_style_packs: "查看风格包",
  apply_style_pack: "套用风格包",
  set_stage: "更新阶段",
};

const stageLabels = { brief: "需求", study: "学习", plan: "分镜", generate: "生成", deliver: "交付" };
const learningLabels = { none: "未开始", slicing: "切片中", annotating: "逐镜分析中", distilling: "归纳中", done: "已完成", failed: "失败" };

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function fileUrl(projectId, path) {
  if (!projectId || !path) return "";
  return `/files/${encodeURIComponent(projectId)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function skillFileUrl(skillId, path) {
  if (!skillId || !path) return "";
  return `/skill-files/${encodeURIComponent(skillId)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function mediaTypeForPath(path) {
  const extension = String(path ?? "").split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  if (["mp4", "webm", "mov", "m4v", "ogv"].includes(extension)) return "video";
  if (["mp3", "m4a", "wav", "aac", "ogg", "flac"].includes(extension)) return "audio";
  if (["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp", "svg"].includes(extension)) return "image";
  return null;
}

function formatSeconds(value) {
  const number = Number(value ?? 0);
  return `${number.toFixed(number % 1 === 0 ? 0 : 2)}s`;
}

function formatUpdatedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatDuration(ms) {
  const total = Math.max(0, Number(ms) || 0);
  if (total < 1) return "<1ms";
  if (total < 1000) return `${Math.round(total)}ms`;
  const seconds = total / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function skillStatusLabel(status) {
  return status === "active" ? "生效" : status === "candidate" ? "候选" : status === "deprecated" ? "停用" : status;
}

function skillKindLabel(kind) {
  const labels = { camera: "运镜", lighting: "灯光", color: "色彩", composition: "构图", rhythm: "节奏", prompt: "提示词", sound: "声音", workflow: "流程", avoid: "避坑" };
  return labels[kind] || kind;
}

function shotStatusLabel(status) {
  const labels = { planned: "待生成", promptReady: "提示词就绪", generating: "生成中", done: "已完成", failed: "失败" };
  return labels[status] || status;
}

function learningStateLabel(learning) {
  if (learning.status === "done" && learning.warning) return "已完成 · 有提示";
  return learningLabels[learning.status] || learning.status;
}

function readableLearningWarning(warning) {
  if (!warning) return "";
  if (warning.includes("返回内容不是 JSON")) return "风格归纳使用规则版回退；可重新学习或手动修正风格圣经。";
  return warning;
}

function resetMediaDialog() {
  const video = els.mediaDialogVideo;
  const audio = els.mediaDialogAudio;
  const image = els.mediaDialogImage;
  video.pause();
  video.removeAttribute("src");
  video.removeAttribute("poster");
  video.load();
  video.hidden = true;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  audio.hidden = true;
  image.removeAttribute("src");
  image.alt = "";
  image.hidden = true;
  image.onload = null;
  video.onloadedmetadata = null;
  els.mediaDialog.style.width = "";
}

function sizeMediaDialog(width, height) {
  if (!width || !height) return;
  els.mediaDialog.style.width = height > width
    ? "min(420px, calc(100vw - 32px))"
    : "min(1120px, calc(100vw - 32px))";
}

function openMedia({ src, type, title, openUrl }) {
  if (!src) return;
  delete els.mediaDialog.dataset.closing;
  resetMediaDialog();
  const kind = type || mediaTypeForPath(src) || "image";
  const kindLabel = kind === "video" ? "视频" : kind === "audio" ? "音频" : "图片";
  const cleanTitle = String(title || "").replace(/^(frame|video|still|source|clip|audio)\s*·\s*/i, "");
  els.mediaDialogTitle.textContent = cleanTitle ? `${kindLabel} · ${cleanTitle}` : kindLabel;
  els.mediaDialogOpen.href = openUrl || src;
  if (kind === "video") {
    els.mediaDialogVideo.onloadedmetadata = () => sizeMediaDialog(els.mediaDialogVideo.videoWidth, els.mediaDialogVideo.videoHeight);
    els.mediaDialogVideo.src = src;
    els.mediaDialogVideo.hidden = false;
    els.mediaDialogVideo.play().catch(() => {});
  } else if (kind === "audio") {
    els.mediaDialog.style.width = "min(560px, calc(100vw - 32px))";
    els.mediaDialogAudio.src = src;
    els.mediaDialogAudio.hidden = false;
    els.mediaDialogAudio.play().catch(() => {});
  } else {
    els.mediaDialogImage.onload = () => sizeMediaDialog(els.mediaDialogImage.naturalWidth, els.mediaDialogImage.naturalHeight);
    els.mediaDialogImage.src = src;
    els.mediaDialogImage.alt = title || "";
    els.mediaDialogImage.hidden = false;
  }
  if (!els.mediaDialog.open) els.mediaDialog.showModal();
}

function closeMedia() {
  if (!els.mediaDialog.open) return;
  els.mediaDialog.dataset.closing = "1";
  els.mediaDialog.close();
  resetMediaDialog();
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function clearEmptyState() {
  els.messages.querySelector(".emptyState")?.remove();
}

function addBubble(role, content, isError = false) {
  clearEmptyState();
  const bubble = document.createElement("div");
  bubble.className = `bubble ${isError ? "error" : role}`;
  bubble.textContent = content;
  els.messages.append(bubble);
  scrollToBottom();
}

function addToolCard(event) {
  clearEmptyState();
  const card = document.createElement("div");
  card.className = "toolCard";
  card.dataset.id = event.id;
  card.innerHTML = `
    <div class="toolHead">
      <span class="toolName">${escapeHtml(toolLabels[event.name] || event.name)}</span>
      <span class="muted">${escapeHtml(event.name)}</span>
      <span class="status">运行中…</span>
      <span class="toolDuration"></span>
    </div>
    <div class="toolArgs">${escapeHtml(JSON.stringify(event.args ?? {}).slice(0, 400))}</div>
    <div class="progress"><i></i></div>
    <div class="progressLabel">准备中</div>`;
  card.dataset.startedAt = String(performance.now());
  els.messages.append(card);
  state.toolCards.set(event.id, card);
  scrollToBottom();
}

function updateToolProgress(event) {
  const card = state.toolCards.get(event.scope);
  if (!card) return;
  const bar = card.querySelector(".progress i");
  const label = card.querySelector(".progressLabel");
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, event.percent))}%`;
  if (label) label.textContent = `${event.percent}% · ${event.label}`;
  scrollToBottom();
}

function finishToolCard(event) {
  const card = state.toolCards.get(event.id);
  if (!card) return;
  const status = card.querySelector(".status");
  if (status) {
    status.textContent = event.ok ? "完成" : "失败";
    status.classList.add(event.ok ? "ok" : "fail");
  }
  const bar = card.querySelector(".progress i");
  if (bar && event.ok) bar.style.width = "100%";
  const label = card.querySelector(".progressLabel");
  if (label) label.textContent = event.preview.slice(0, 300);
  const startedAt = Number(card.dataset.startedAt);
  const fallback = Number.isFinite(startedAt) ? performance.now() - startedAt : 0;
  const elapsed = Number.isFinite(Number(event.elapsedMs)) ? Number(event.elapsedMs) : fallback;
  const duration = card.querySelector(".toolDuration");
  if (duration) {
    duration.textContent = `耗时 ${formatDuration(elapsed)}`;
    duration.title = "工具执行耗时";
  }
  scrollToBottom();
}

function renderProjectList() {
  if (!state.projects.length) {
    els.projectList.innerHTML = '<p class="muted" style="font-size:12px;padding:0 6px">还没有项目</p>';
    return;
  }
  els.projectList.innerHTML = state.projects.map(project => `
    <button class="projectItem ${state.project?.id === project.id ? "active" : ""}" data-id="${escapeHtml(project.id)}">
      <strong>${escapeHtml(project.title)}</strong>
      <span>${escapeHtml(stageLabels[project.stage] || project.stage)} · ${project.shotCount} 镜 · ${escapeHtml(learningLabels[project.learning] || project.learning)}</span>
    </button>`).join("");
  for (const button of els.projectList.querySelectorAll(".projectItem")) {
    button.addEventListener("click", () => selectProject(button.dataset.id));
  }
}

function renderPacks() {
  if (!state.packs.length) {
    els.packList.innerHTML = '<p class="muted" style="font-size:12px;padding:0 6px">学习参考片后自动生成</p>';
    return;
  }
  els.packList.innerHTML = state.packs.map(pack => `
    <div class="packItem" title="对 Agent 说：套用风格包 ${escapeHtml(pack.id)}">
      <strong>${escapeHtml(pack.title)}</strong>
      <p>${escapeHtml(pack.summary)}</p>
      <p>${escapeHtml(pack.characters.join("、") || "无角色")} · ${pack.shotCount} 镜</p>
    </div>`).join("");
}

function renderHistory(messages) {
  els.messages.innerHTML = "";
  if (!messages.length) {
    els.messages.innerHTML = `<div class="emptyState">
      <h2>先给一个参考片，或者直接说想法</h2>
      <p>例：学习 <code>/Users/you/Movies/reference.mp4</code> 的运镜和光线，做一个 8 秒的雨夜街头镜头。</p>
      <p>学习流程：ffmpeg 切片 → 视觉模型逐镜头拉片 → 归纳定妆照、场景照、运镜与节奏 → H3 生成。</p>
    </div>`;
    return;
  }
  for (const message of messages) addBubble(message.role, message.content);
}

function renderEntity(project, entity, kind) {
  const images = entity.stillImages || [];
  const imageLabel = kind === "character" ? "定妆照" : "场景照";
  return `<div class="entity">
    <div class="entityHead"><b>${escapeHtml(entity.name)}</b><span>${escapeHtml(entity.id)}</span></div>
    <p>${escapeHtml(entity.descriptionZh)}</p>
    ${images.length ? `<div class="thumbs">${images.slice(0, 3).map(path => {
      const src = fileUrl(project.id, path);
      return `<a class="mediaThumb" href="${src}" data-media-src="${src}" data-media-type="image" data-media-title="${escapeHtml(entity.name)} · ${imageLabel}" target="_blank" rel="noreferrer"><img src="${src}" alt="${escapeHtml(entity.name)}" /></a>`;
    }).join("")}</div>` : ""}
  </div>`;
}

function renderSkillCard(skill) {
  return `<details class="skillCard">
    <summary>
      <span class="skillName">${escapeHtml(skill.name)}</span>
      <span class="skillKind">${escapeHtml(skillKindLabel(skill.kind))}</span>
      <span class="skillConfidence">${Number(skill.confidence).toFixed(2)}</span>
    </summary>
    <p>${escapeHtml(skill.summaryZh)}</p>
    ${(skill.applicableWhen || []).length ? `<div class="chips">${skill.applicableWhen.map(item => `<span class="chip">${escapeHtml(item)}</span>`).join("")}</div>` : ""}
    ${skill.instruction ? `<p class="skillInstruction">${escapeHtml(skill.instruction)}</p>` : ""}
    ${skill.promptFragment ? `<pre>${escapeHtml(skill.promptFragment)}</pre>` : ""}
    ${(skill.images || []).length ? `<div class="thumbs">${skill.images.map(image => {
      const src = skillFileUrl(skill.id, image);
      return `<a class="mediaThumb" href="${src}" data-media-src="${src}" data-media-type="image" data-media-title="${escapeHtml(skill.name)} · 证据" target="_blank" rel="noreferrer"><img loading="lazy" src="${src}" alt="${escapeHtml(skill.name)}" /></a>`;
    }).join("")}</div>` : ""}
    <p class="skillStats"><span class="statusDot ${escapeHtml(skill.status)}"></span>${escapeHtml(skillStatusLabel(skill.status))} · 证据 ${skill.evidenceCount} · 使用 ${skill.used} · 好评 ${skill.good} / 一般 ${skill.mixed} / 差评 ${skill.bad}</p>
  </details>`;
}

function renderSkills() {
  const all = state.skills || [];
  if (!all.length) {
    return `<section class="inspectorSection">
      <div class="sectionHead"><h3>技能库</h3><span class="count">0</span></div>
      <p class="emptyHint">学习参考片后自动积累；生成后反馈效果会调整置信度。</p>
    </section>`;
  }
  const counts = {
    all: all.length,
    active: all.filter(skill => skill.status === "active").length,
    candidate: all.filter(skill => skill.status === "candidate").length,
    deprecated: all.filter(skill => skill.status === "deprecated").length,
  };
  const filters = [
    ["all", "全部", counts.all],
    ["active", "生效", counts.active],
    ["candidate", "候选", counts.candidate],
    ["deprecated", "停用", counts.deprecated],
  ].filter(([, , count]) => count > 0);
  const filter = filters.some(([value]) => value === state.skillFilter) ? state.skillFilter : "all";
  const filtered = all
    .filter(skill => filter === "all" || skill.status === filter)
    .sort((left, right) => {
      const rank = status => status === "active" ? 0 : status === "candidate" ? 1 : 2;
      return rank(left.status) - rank(right.status) || Number(right.confidence) - Number(left.confidence);
    });
  const visible = state.showAllSkills ? filtered : filtered.slice(0, 8);
  return `<section class="inspectorSection">
    <div class="sectionHead"><h3>技能库</h3><span class="count">${filter === "all" ? all.length : `${filtered.length} / ${all.length}`}</span></div>
    <div class="filterChips">${filters.map(([value, label, count]) => `<button class="filterChip ${filter === value ? "active" : ""}" data-skill-filter="${value}">${label}<span>${count}</span></button>`).join("")}</div>
    <p class="sectionHint">按 生效 → 候选 排序，置信度 0–1（越高越可信）。</p>
    ${visible.length ? visible.map(renderSkillCard).join("") : `<p class="emptyHint">没有这个状态的技能。</p>`}
    ${filtered.length > 8 ? `<button class="textButton" data-show-all-skills>${state.showAllSkills ? "收起" : `显示全部 ${filtered.length} 条`}</button>` : ""}
  </section>`;
}

function renderOverview(project, shots, bible, brief, learning) {
  const parts = [];
  parts.push(`<section class="inspectorSection">
    <div class="sectionHead"><h3>需求</h3></div>
    <div class="briefCard">
      <p class="briefIdea">${brief.idea ? escapeHtml(brief.idea) : '<span class="muted">还没有记录需求</span>'}</p>
      <div class="metaGrid">
        <div><b>类型</b><span title="${escapeHtml(brief.genre || "-")}">${escapeHtml(brief.genre || "-")}</span></div>
        <div><b>画幅</b><span title="${escapeHtml(brief.aspectRatio || "-")}">${escapeHtml(brief.aspectRatio || "-")}</span></div>
        <div><b>目标时长</b><span title="${brief.durationSeconds ? `${brief.durationSeconds} 秒` : "-"}">${brief.durationSeconds ? `${brief.durationSeconds} 秒` : "-"}</span></div>
      </div>
      ${((brief.mustKeep || []).length + (brief.avoid || []).length) ? `<details class="fold">
        <summary>约束 <span class="count">${(brief.mustKeep || []).length + (brief.avoid || []).length} 条</span></summary>
        <div class="chips">
          ${(brief.mustKeep || []).map(item => `<span class="chip">保留：${escapeHtml(item)}</span>`).join("")}
          ${(brief.avoid || []).map(item => `<span class="chip">避免：${escapeHtml(item)}</span>`).join("")}
        </div>
      </details>` : ""}
    </div>
  </section>`);

  const resolution = learning.sourceWidth && learning.sourceHeight ? `${learning.sourceWidth}×${learning.sourceHeight}` : "";
  parts.push(`<section class="inspectorSection">
    <div class="sectionHead"><h3>学习状态</h3><span class="count">${escapeHtml(learningStateLabel(learning))}</span></div>
    ${learning.error ? `<p class="inlineWarning error">${escapeHtml(learning.error)}</p>` : ""}
    ${learning.warning ? `<p class="inlineWarning warn">${escapeHtml(readableLearningWarning(learning.warning))}</p>` : ""}
    <div class="statRow">
      <span class="stat"><b>${learning.shotCount ?? 0}</b>参考镜头</span>
      ${learning.sourceDuration ? `<span class="stat"><b>${formatSeconds(learning.sourceDuration)}</b>时长</span>` : ""}
      ${resolution ? `<span class="stat"><b>${escapeHtml(resolution)}</b>分辨率</span>` : ""}
    </div>
    ${shots.length ? `<details class="fold">
      <summary>参考镜头 <span class="count">${shots.length} 个</span></summary>
      <div class="shotGrid">${shots.map(shot => `
        <div class="shotCard">
          <a class="mediaThumb" href="${fileUrl(project.id, shot.keyframe)}" data-media-src="${fileUrl(project.id, shot.keyframe)}" data-media-type="image" data-media-title="${escapeHtml(shot.id)} 关键帧" target="_blank" rel="noreferrer"><img loading="lazy" src="${fileUrl(project.id, shot.keyframe)}" alt="${escapeHtml(shot.id)}" /></a>
          <div class="shotMeta"><strong>${escapeHtml(shot.id)} · ${formatSeconds(shot.duration)}</strong>${escapeHtml(shot.shotSize || "-")} · ${escapeHtml((shot.movement || "").slice(0, 42))}</div>
        </div>`).join("")}</div>
    </details>` : `<p class="emptyHint">还没有参考镜头。</p>`}
  </section>`);

  if (!bible) {
    parts.push(`<p class="emptyHint">还没有风格圣经。学习参考片后会自动生成角色、场景与运镜。</p>`);
    return parts.join("");
  }

  const characters = bible.characters || [];
  const locations = bible.locations || [];
  const moves = bible.cameraGrammar || [];
  parts.push(`<section class="inspectorSection">
    <div class="sectionHead"><h3>风格圣经</h3><span class="count">${escapeHtml(bible.rhythm?.averageShotSeconds ?? "-")}s/镜</span></div>
    <div class="bibleCard">
      <p class="bibleSummary">${escapeHtml(bible.summary)}</p>
      <div class="chips">
        ${characters.map(character => `<span class="chip">角色 · ${escapeHtml(character.name)}</span>`).join("")}
        ${locations.map(location => `<span class="chip">场景 · ${escapeHtml(location.name)}</span>`).join("")}
      </div>
      ${characters.length || locations.length ? `<details class="fold">
        <summary>角色与场景 <span class="count">${characters.length + locations.length} 项</span></summary>
        ${characters.map(character => renderEntity(project, character, "character")).join("")}
        ${locations.map(location => renderEntity(project, location, "location")).join("")}
      </details>` : ""}
      ${moves.length ? `<details class="fold">
        <summary>运镜语法 <span class="count">${moves.length} 条</span></summary>
        <ul class="cameraList">${moves.map(move => `<li><b>${escapeHtml(move.name)}</b><span>${escapeHtml(move.descriptionZh || move.promptFragment || "")}</span></li>`).join("")}</ul>
      </details>` : ""}
      ${bible.style?.stylePrefix ? `<details class="fold">
        <summary>风格前缀</summary>
        <p class="stylePrefix">${escapeHtml(bible.style.stylePrefix)}</p>
      </details>` : ""}
    </div>
  </section>`);
  return parts.join("");
}

function renderPlan(project) {
  const plan = project.plan || [];
  if (!plan.length) {
    return `<section class="inspectorSection">
      <div class="sectionHead"><h3>分镜</h3><span class="count">0</span></div>
      <p class="emptyHint">还没有分镜。先在左侧对话里描述想法，让 Agent 规划镜头。</p>
    </section>`;
  }
  return `<section class="inspectorSection">
    <div class="sectionHead"><h3>分镜</h3></div>
    <p class="sectionHint">点击视频封面，在弹窗里播放。</p>
    ${plan.map(shot => {
      const videoUrl = shot.video ? fileUrl(project.id, shot.video) : "";
      const preview = shot.video
        ? (project.assets || []).find(asset => asset.kind === "frame" && asset.meta?.shotId === shot.id && (asset.label.includes("预览") || asset.path.includes("preview")))
        : undefined;
      const posterUrl = preview ? fileUrl(project.id, preview.path) : "";
      return `<div class="planRow">
        <div class="planBody">
          <div class="planMiniMedia">
            ${shot.video ? `<button class="videoPoster mini" type="button" data-media-src="${videoUrl}" data-media-type="video" data-media-title="${escapeHtml(`${shot.id} ${shot.title}`)}" data-media-open="${videoUrl}" aria-label="弹窗预览 ${escapeHtml(shot.id)}"><video muted preload="metadata" playsinline ${posterUrl ? `poster="${posterUrl}"` : ""} src="${videoUrl}"></video><span class="playBadge"><span>▶</span></span></button>` : `<div class="planPlaceholder mini">${shot.status === "generating" ? "生成中…" : "未生成"}</div>`}
          </div>
          <div class="planInfo">
            <div class="planHead"><b>${escapeHtml(shot.id)}</b><span class="muted">${formatSeconds(shot.durationSeconds)}</span><span class="state ${escapeHtml(shot.status)}">${escapeHtml(shotStatusLabel(shot.status))}</span></div>
            <p class="planAction"><b>${escapeHtml(shot.title)}</b></p>
            ${shot.action ? `<details class="fold planDetails"><summary>镜头描述</summary><p>${escapeHtml(shot.action)}</p></details>` : ""}
            ${shot.error ? `<p class="inlineWarning error">${escapeHtml(shot.error)}</p>` : ""}
            ${shot.prompt ? `<details><summary>H3 提示词 · ${escapeHtml(shot.promptMode || "")}</summary><pre>${escapeHtml(shot.prompt)}</pre></details>` : ""}
          </div>
        </div>
      </div>`;
    }).join("")}
  </section>`;
}

function renderAssets(project) {
  const items = (project.assets || []).slice().reverse().map(asset => ({ asset, type: mediaTypeForPath(asset.path) || "other" }));
  const counts = { all: items.length, video: 0, image: 0, audio: 0, other: 0 };
  for (const item of items) counts[item.type] += 1;
  const filters = [
    ["all", "全部", counts.all],
    ["video", "视频", counts.video],
    ["image", "图片", counts.image],
    ["audio", "音频", counts.audio],
    ["other", "其他", counts.other],
  ].filter(([, , count]) => count > 0);
  const filter = filters.some(([value]) => value === state.assetFilter) ? state.assetFilter : "all";
  const filtered = filter === "all" ? items : items.filter(item => item.type === filter);
  const visible = filtered.slice(0, 24);
  const typeLabels = { video: "视频", image: "图片", audio: "音频", other: "文件" };
  return `<section class="inspectorSection">
    <div class="sectionHead"><h3>素材</h3><span class="count">${filter === "all" ? items.length : `${filtered.length} / ${items.length}`}</span></div>
    <div class="filterChips">${filters.map(([value, label, count]) => `<button class="filterChip ${filter === value ? "active" : ""}" data-asset-filter="${value}">${label}<span>${count}</span></button>`).join("")}</div>
    ${visible.length ? `<div class="assetGrid">${visible.map(({ asset, type }) => {
      const src = fileUrl(project.id, asset.path);
      const title = asset.label;
      if (type === "other") return `<a class="assetPlain" href="${src}" target="_blank" rel="noreferrer">${escapeHtml(asset.kind)} · ${escapeHtml(asset.label)}</a>`;
      const thumb = type === "image"
        ? `<img loading="lazy" src="${src}" alt="" />`
        : type === "video"
          ? `<video muted preload="metadata" playsinline src="${src}"></video><span class="assetPlay">▶</span>`
          : `<span class="assetAudio">♪</span>`;
      return `<button class="assetCard" type="button" title="${escapeHtml(title)}" data-media-src="${src}" data-media-type="${type}" data-media-title="${escapeHtml(title)}" data-media-open="${src}"><span class="assetThumb">${thumb}</span><span class="assetLabel"><b>${typeLabels[type]}</b>${escapeHtml(asset.label)}</span></button>`;
    }).join("")}</div>` : `<p class="emptyHint">${filter === "all" ? "还没有素材。" : "没有这类素材。"}</p>`}
    ${filtered.length > visible.length ? `<p class="sectionHint">显示最近 ${visible.length} 个，共 ${filtered.length} 个。</p>` : ""}
  </section>`;
}

function renderInspector(project = state.project, shots = state.shots) {
  if (!project) {
    els.inspector.innerHTML = '<div class="emptyState small"><p>选择或新建项目后，这里显示学习成果、分镜与素材。</p></div>';
    return;
  }
  const planCount = (project.plan || []).length;
  const assetCount = (project.assets || []).length;
  const skillCount = (state.skills || []).length;
  const requested = state.inspectorTab;
  const tabs = [
    ["overview", "概览", 0],
    ["shots", "分镜", planCount],
    ["assets", "素材", assetCount],
    ["skills", "技能", skillCount],
  ];
  const tab = tabs.some(([id]) => id === requested) ? requested : (planCount ? "shots" : "overview");
  const bible = project.styleBible;
  const brief = project.brief || {};
  const learning = project.learning || { status: "none" };
  let content = "";
  if (tab === "overview") content = renderOverview(project, shots, bible, brief, learning);
  else if (tab === "shots") content = renderPlan(project);
  else if (tab === "assets") content = renderAssets(project);
  else content = renderSkills();

  els.inspector.innerHTML = `<header class="inspectorHeader">
    <div class="inspectorTitleRow">
      <div class="inspectorTitleText">
        <h2>${escapeHtml(project.title)}</h2>
        <p>最后更新 ${escapeHtml(formatUpdatedAt(project.updatedAt))}</p>
      </div>
      <span class="stageBadge">${escapeHtml(stageLabels[project.stage] || project.stage)}</span>
    </div>
    <nav class="inspectorTabs" role="tablist">${tabs.map(([id, label, count]) => `<button class="inspectorTab ${tab === id ? "active" : ""}" data-inspector-tab="${id}" role="tab" aria-selected="${tab === id}">${label}${count ? `<span>${count}</span>` : ""}</button>`).join("")}</nav>
  </header>
  <div class="inspectorContent">${content}</div>`;
}

async function loadProjects() {
  const data = await api("/api/projects");
  state.projects = data.projects || [];
  renderProjectList();
}

async function loadPacks() {
  const data = await api("/api/library/packs");
  state.packs = data.packs || [];
  renderPacks();
}

async function loadSkills() {
  const data = await api("/api/skills");
  state.skills = data.skills || [];
}

async function refreshDetail() {
  if (!state.project) return;
  const data = await api(`/api/projects/${encodeURIComponent(state.project.id)}`);
  state.project = data.project;
  state.shots = data.shots || [];
  renderInspector();
  renderProjectList();
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => {
    refreshDetail().catch(error => console.warn(error));
    loadPacks().catch(() => {});
    loadSkills().then(() => { if (state.project) renderInspector(); }).catch(() => {});
  }, 400);
}

async function selectProject(id) {
  closeMedia();
  state.inspectorTab = null;
  state.assetFilter = "all";
  state.skillFilter = "all";
  state.showAllSkills = false;
  try {
    const data = await api(`/api/projects/${encodeURIComponent(id)}`);
    state.project = data.project;
    state.shots = data.shots || [];
    state.toolCards.clear();
    renderHistory(data.messages || []);
    renderInspector();
    renderProjectList();
  } catch (error) {
    addBubble("assistant", `打开项目失败：${error.message}`, true);
  }
}

function setStreaming(value) {
  state.streaming = value;
  els.sendButton.disabled = value;
  els.sendButton.textContent = value ? "生成中…" : "发送";
}

async function sendMessage(message) {
  if (!state.project) {
    addBubble("assistant", "请先新建或选择一个项目。", true);
    return;
  }
  setStreaming(true);
  addBubble("user", message);
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(state.project.id)}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!response.ok || !response.body) {
      const text = await response.text();
      throw new Error(text || `HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          let event;
          try {
            event = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          handleEvent(event);
        }
      }
    }
  } catch (error) {
    addBubble("assistant", `请求失败：${error.message}`, true);
  } finally {
    setStreaming(false);
    scheduleRefresh();
  }
}

function handleEvent(event) {
  if (event.type === "message") {
    if (event.role === "user") return;
    addBubble("assistant", event.content);
  } else if (event.type === "tool_start") {
    addToolCard(event);
  } else if (event.type === "progress") {
    updateToolProgress(event);
  } else if (event.type === "tool_end") {
    finishToolCard(event);
  } else if (event.type === "state") {
    state.project = event.project;
    renderInspector();
    renderProjectList();
    scheduleRefresh();
  } else if (event.type === "error") {
    addBubble("assistant", `出错了：${event.message}`, true);
  }
}

function renderEngineState() {
  const settings = state.settings;
  if (!settings) return;
  const flags = [
    settings.llm?.model ? "LLM" : null,
    settings.llm?.visionModel ? "VLM" : null,
    settings.video?.apiKey ? "H3" : null,
    settings.image?.model ? "图片" : null,
  ].filter(Boolean);
  els.engineState.textContent = flags.length ? `已配置：${flags.join(" · ")}` : "尚未配置模型";
  els.engineState.className = `engineState ${flags.length >= 3 ? "ok" : "warn"}`;
}

function setDeep(target, path, value) {
  const keys = path.split(".");
  let current = target;
  for (const key of keys.slice(0, -1)) {
    current[key] ??= {};
    current = current[key];
  }
  current[keys.at(-1)] = value;
}

function getDeep(target, path) {
  return path.split(".").reduce((value, key) => (value == null ? value : value[key]), target);
}

async function loadSettings() {
  state.settings = await api("/api/settings");
  renderEngineState();
}

els.composer.addEventListener("submit", event => {
  event.preventDefault();
  const message = els.input.value.trim();
  if (!message || state.streaming) return;
  els.input.value = "";
  sendMessage(message);
});

els.input.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    els.composer.requestSubmit();
  }
});

els.newProjectButton.addEventListener("click", async () => {
  const title = window.prompt("项目名称", "我的视频项目");
  if (title === null) return;
  try {
    const data = await api("/api/projects", { method: "POST", body: JSON.stringify({ title }) });
    await loadProjects();
    await selectProject(data.project.id);
    els.input.focus();
  } catch (error) {
    addBubble("assistant", `创建项目失败：${error.message}`, true);
  }
});

els.settingsButton.addEventListener("click", async () => {
  try {
    await loadSettings();
  } catch (error) {
    addBubble("assistant", `读取设置失败：${error.message}`, true);
    return;
  }
  const settings = state.settings;
  for (const input of els.settingsForm.querySelectorAll("input[name]")) {
    const value = getDeep(settings, input.name);
    input.value = value == null ? "" : String(value);
  }
  els.settingsDialog.showModal();
});

els.mediaDialog.addEventListener("cancel", () => {
  els.mediaDialog.dataset.closing = "1";
  resetMediaDialog();
});
els.mediaDialog.addEventListener("close", () => {
  if (els.mediaDialog.dataset.closing === "1") {
    delete els.mediaDialog.dataset.closing;
    resetMediaDialog();
  }
});
els.mediaDialog.addEventListener("click", event => {
  if (event.target === els.mediaDialog) closeMedia();
});
els.mediaDialogClose.addEventListener("click", closeMedia);
els.inspector.addEventListener("click", event => {
  if (!(event.target instanceof Element)) return;
  const tab = event.target.closest("[data-inspector-tab]");
  if (tab) {
    state.inspectorTab = tab.dataset.inspectorTab;
    els.inspector.scrollTop = 0;
    renderInspector();
    return;
  }
  const assetFilter = event.target.closest("[data-asset-filter]");
  if (assetFilter) {
    state.assetFilter = assetFilter.dataset.assetFilter;
    renderInspector();
    return;
  }
  const skillFilter = event.target.closest("[data-skill-filter]");
  if (skillFilter) {
    state.skillFilter = skillFilter.dataset.skillFilter;
    state.showAllSkills = false;
    renderInspector();
    return;
  }
  if (event.target.closest("[data-show-all-skills]")) {
    state.showAllSkills = !state.showAllSkills;
    renderInspector();
    return;
  }
  const trigger = event.target.closest("[data-media-src]");
  if (!trigger || !els.inspector.contains(trigger)) return;
  event.preventDefault();
  const src = trigger.dataset.mediaSrc;
  openMedia({
    src,
    type: trigger.dataset.mediaType || mediaTypeForPath(src) || "image",
    title: trigger.dataset.mediaTitle || "",
    openUrl: trigger.dataset.mediaOpen || trigger.getAttribute("href") || src,
  });
});

els.settingsForm.addEventListener("submit", async event => {
  event.preventDefault();
  const submitter = event.submitter;
  if (!submitter || submitter.value !== "save") {
    els.settingsDialog.close();
    return;
  }
  const next = structuredClone(state.settings);
  for (const input of els.settingsForm.querySelectorAll("input[name]")) {
    setDeep(next, input.name, input.value.trim());
  }
  try {
    state.settings = await api("/api/settings", { method: "PUT", body: JSON.stringify({ settings: next }) });
    renderEngineState();
    els.settingsDialog.close();
  } catch (error) {
    addBubble("assistant", `保存设置失败：${error.message}`, true);
  }
});

(async function boot() {
  try {
    await Promise.all([loadSettings(), loadPacks(), loadSkills(), loadProjects()]);
    if (state.projects.length) {
      await selectProject(state.projects[0].id);
    } else {
      renderInspector();
    }
  } catch (error) {
    addBubble("assistant", `初始化失败：${error.message}`, true);
  }
})();
