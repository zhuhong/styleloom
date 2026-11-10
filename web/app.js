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

function formatSeconds(value) {
  const number = Number(value ?? 0);
  return `${number.toFixed(number % 1 === 0 ? 0 : 2)}s`;
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
    </div>
    <div class="toolArgs">${escapeHtml(JSON.stringify(event.args ?? {}).slice(0, 400))}</div>
    <div class="progress"><i></i></div>
    <div class="progressLabel">准备中</div>`;
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

function renderSkills() {
  if (!state.skills.length) {
    return `<div class="inspectorSection">
      <h3>技能库 <span class="count">0</span></h3>
      <p class="muted" style="font-size:12px">学习参考片后自动积累；生成后反馈效果会调整置信度。</p>
    </div>`;
  }
  return `<div class="inspectorSection">
    <h3>技能库 <span class="count">${state.skills.length}</span></h3>
    ${state.skills.slice(0, 12).map(skill => `<details class="skillCard">
      <summary>
        <span class="skillName">${escapeHtml(skill.name)}</span>
        <span class="skillKind">${escapeHtml(skill.kind)}</span>
        <span class="skillConfidence">${Number(skill.confidence).toFixed(2)}</span>
      </summary>
      <p>${escapeHtml(skill.summaryZh)}</p>
      ${(skill.applicableWhen || []).length ? `<div class="chips">${skill.applicableWhen.map(item => `<span class="chip">${escapeHtml(item)}</span>`).join("")}</div>` : ""}
      ${skill.instruction ? `<p class="skillInstruction">${escapeHtml(skill.instruction)}</p>` : ""}
      ${skill.promptFragment ? `<pre>${escapeHtml(skill.promptFragment)}</pre>` : ""}
      ${(skill.images || []).length ? `<div class="thumbs">${skill.images.map(image => `<a href="/skill-files/${encodeURIComponent(skill.id)}/${image.split("/").map(encodeURIComponent).join("/")}" target="_blank" rel="noreferrer"><img src="/skill-files/${encodeURIComponent(skill.id)}/${image.split("/").map(encodeURIComponent).join("/")}" alt="${escapeHtml(skill.name)}" /></a>`).join("")}</div>` : ""}
      <p class="skillStats">${escapeHtml(skill.status)} · 证据 ${skill.evidenceCount} · 使用 ${skill.used} · 好评 ${skill.good} / 一般 ${skill.mixed} / 差评 ${skill.bad}</p>
    </details>`).join("")}
  </div>`;
}

function renderInspector(project = state.project, shots = state.shots) {
  if (!project) {
    els.inspector.innerHTML = '<div class="emptyState small"><p>选择或新建项目后，这里显示学习成果、分镜与素材。</p></div>';
    return;
  }
  const bible = project.styleBible;
  const brief = project.brief || {};
  const sections = [];

  sections.push(`<div class="inspectorSection">
    <h3>${escapeHtml(project.title)} <span class="stageBadge">${escapeHtml(stageLabels[project.stage] || project.stage)}</span></h3>
    <div class="briefCard">
      <p>${brief.idea ? escapeHtml(brief.idea) : '<span class="muted">还没有记录需求</span>'}</p>
      <div class="kv"><b>类型</b><span>${escapeHtml(brief.genre || "-")}</span></div>
      <div class="kv"><b>画幅</b><span>${escapeHtml(brief.aspectRatio || "-")}</span></div>
      <div class="kv"><b>目标时长</b><span>${brief.durationSeconds ? `${brief.durationSeconds} 秒` : "-"}</span></div>
      ${(brief.mustKeep || []).length ? `<div class="chips">${brief.mustKeep.map(item => `<span class="chip">保留：${escapeHtml(item)}</span>`).join("")}</div>` : ""}
      ${(brief.avoid || []).length ? `<div class="chips">${brief.avoid.map(item => `<span class="chip">避免：${escapeHtml(item)}</span>`).join("")}</div>` : ""}
    </div>
  </div>`);

  const learning = project.learning || { status: "none" };
  sections.push(`<div class="inspectorSection">
    <h3>学习 <span class="count">${escapeHtml(learningLabels[learning.status] || learning.status)}</span></h3>
    ${learning.error ? `<p class="muted" style="font-size:12px;color:#fca5a5">${escapeHtml(learning.error)}</p>` : ""}
    ${learning.warning ? `<p class="muted" style="font-size:12px;color:#fbbf24">${escapeHtml(learning.warning)}</p>` : ""}
    ${learning.shotCount ? `<p class="muted" style="font-size:12px">${learning.shotCount} 个镜头 · ${formatSeconds(learning.sourceDuration)} · ${learning.sourceWidth}×${learning.sourceHeight}</p>` : ""}
    ${shots.length ? `<div class="shotGrid" style="margin-top:10px">${shots.map(shot => `
      <div class="shotCard">
        <a href="${fileUrl(project.id, shot.keyframe)}" target="_blank" rel="noreferrer"><img loading="lazy" src="${fileUrl(project.id, shot.keyframe)}" alt="${escapeHtml(shot.id)}" /></a>
        <div class="shotMeta"><strong>${escapeHtml(shot.id)} · ${formatSeconds(shot.duration)}</strong>${escapeHtml(shot.shotSize || "-")} · ${escapeHtml((shot.movement || "").slice(0, 42))}</div>
      </div>`).join("")}</div>` : ""}
  </div>`);

  if (bible) {
    sections.push(`<div class="inspectorSection">
      <h3>风格圣经 <span class="count">${escapeHtml(bible.rhythm?.averageShotSeconds ?? "-")}s/镜</span></h3>
      <div class="bibleCard">
        <p style="margin:0 0 8px">${escapeHtml(bible.summary)}</p>
        <p class="muted" style="font-size:11px;margin:0">${escapeHtml(bible.style?.stylePrefix)}</p>
      </div>
      <div style="margin-top:10px">
        ${(bible.characters || []).map(character => `<div class="entity">
          <div class="entityHead"><b>${escapeHtml(character.name)}</b><span>${escapeHtml(character.id)}</span></div>
          <p>${escapeHtml(character.descriptionZh)}</p>
          ${(character.stillImages || []).length ? `<div class="thumbs">${character.stillImages.slice(0, 3).map(path => `<a href="${fileUrl(project.id, path)}" target="_blank" rel="noreferrer"><img src="${fileUrl(project.id, path)}" alt="${escapeHtml(character.name)}" /></a>`).join("")}</div>` : ""}
        </div>`).join("")}
      </div>
      <div>
        ${(bible.locations || []).map(location => `<div class="entity">
          <div class="entityHead"><b>${escapeHtml(location.name)}</b><span>${escapeHtml(location.id)}</span></div>
          <p>${escapeHtml(location.descriptionZh)}</p>
          ${(location.stillImages || []).length ? `<div class="thumbs">${location.stillImages.slice(0, 3).map(path => `<a href="${fileUrl(project.id, path)}" target="_blank" rel="noreferrer"><img src="${fileUrl(project.id, path)}" alt="${escapeHtml(location.name)}" /></a>`).join("")}</div>` : ""}
        </div>`).join("")}
      </div>
      <div class="chips">${(bible.cameraGrammar || []).map(move => `<span class="chip">${escapeHtml(move.name)}</span>`).join("")}</div>
    </div>`);
  }

  if ((project.plan || []).length) {
    sections.push(`<div class="inspectorSection">
      <h3>分镜 <span class="count">${project.plan.length}</span></h3>
      ${project.plan.map(shot => `<div class="planRow">
        <div class="planHead"><b>${escapeHtml(shot.id)}</b><span class="muted">${formatSeconds(shot.durationSeconds)}</span><span class="state ${escapeHtml(shot.status)}">${escapeHtml(shot.status)}</span></div>
        <p class="planAction">${escapeHtml(shot.title)} — ${escapeHtml(shot.action)}</p>
        ${shot.video ? `<video controls preload="metadata" src="${fileUrl(project.id, shot.video)}"></video>` : ""}
        ${shot.error ? `<p style="font-size:11px;color:#fca5a5">${escapeHtml(shot.error)}</p>` : ""}
        ${shot.prompt ? `<details><summary>H3 提示词 · ${escapeHtml(shot.promptMode || "")}</summary><pre>${escapeHtml(shot.prompt)}</pre></details>` : ""}
      </div>`).join("")}
    </div>`);
  }

  sections.push(renderSkills());

  if ((project.assets || []).length) {
    sections.push(`<div class="inspectorSection">
      <h3>素材 <span class="count">${project.assets.length}</span></h3>
      <div class="assetList">
        ${project.assets.slice(-16).reverse().map(asset => `<a href="${fileUrl(project.id, asset.path)}" target="_blank" rel="noreferrer">${escapeHtml(asset.kind)} · ${escapeHtml(asset.label)}</a>`).join("")}
      </div>
    </div>`);
  }

  els.inspector.innerHTML = sections.join("");
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
