// 轻量 Markdown 渲染器：只生成受控 HTML，原始 HTML 一律转义，不执行脚本。
const PLACEHOLDER_OPEN = "\uE000";
const PLACEHOLDER_CLOSE = "\uE001";
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HR_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
const TABLE_DELIMITER_RE = /^:?-{3,}:?$/;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function leadingIndent(line) {
  return line.match(/^\s*/)?.[0].replace(/\t/g, "    ").length ?? 0;
}

function safeUrl(raw) {
  let url = String(raw ?? "").trim();
  if (url.startsWith("<") && url.endsWith(">")) url = url.slice(1, -1).trim();
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) return url;
  if (/^\/\//.test(url)) return "";
  if (/^(\/|\.{1,2}\/|#)/.test(url)) return url;
  return "";
}

function restoreTokens(text, tokens) {
  return text.replace(/\uE000(\d+)\uE001/g, (_, index) => tokens[Number(index)] ?? "");
}

function formatEmphasis(text) {
  return text
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/\*\*([^\s*](?:[^*\n]*[^\s*])?)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^\s_](?:[^_\n]*[^\s_])?)__/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])\*([^\s*](?:[^*\n]*[^\s*])?)\*(?=[^\w]|$)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_([^\s_](?:[^_\n]*[^\s_])?)_(?=[^\w]|$)/g, "$1<em>$2</em>");
}

function renderLabel(text, tokens) {
  return restoreTokens(formatEmphasis(escapeHtml(text)), tokens);
}

function tokenizeInline(source) {
  const tokens = [];
  let text = String(source ?? "");

  // 行内代码先占位，里面的 *、[link] 等不再参与后续解析。
  text = text.replace(/(`+)([\s\S]*?)\1/g, (_, _ticks, content) => {
    let code = content.replace(/\n/g, " ");
    if (code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
    const index = tokens.push(`<code class="mdInline">${escapeHtml(code)}</code>`) - 1;
    return `${PLACEHOLDER_OPEN}${index}${PLACEHOLDER_CLOSE}`;
  });

  // 图片必须比链接先处理，否则 ![alt](url) 会只剩链接部分。
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (match, alt, url, title) => {
    const src = safeUrl(url);
    if (!src) {
      const index = tokens.push(escapeHtml(match)) - 1;
      return `${PLACEHOLDER_OPEN}${index}${PLACEHOLDER_CLOSE}`;
    }
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    const index = tokens.push(`<img class="mdImage" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${titleAttr} loading="lazy" />`) - 1;
    return `${PLACEHOLDER_OPEN}${index}${PLACEHOLDER_CLOSE}`;
  });

  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (match, label, url, title) => {
    const href = safeUrl(url);
    if (!href) {
      const index = tokens.push(escapeHtml(match)) - 1;
      return `${PLACEHOLDER_OPEN}${index}${PLACEHOLDER_CLOSE}`;
    }
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    const index = tokens.push(`<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener"${titleAttr}>${renderLabel(label, tokens)}</a>`) - 1;
    return `${PLACEHOLDER_OPEN}${index}${PLACEHOLDER_CLOSE}`;
  });

  // 裸 URL 也做成链接，末尾标点留在链接外。
  text = text.replace(/(^|[\s(])(https?:\/\/[^\s<>"')\]]+)/g, (match, prefix, url) => {
    const trailing = url.match(/[.,;:!?，。；：！？、]+$/)?.[0] ?? "";
    const href = trailing ? url.slice(0, -trailing.length) : url;
    if (!safeUrl(href)) return match;
    const index = tokens.push(`<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${escapeHtml(href)}</a>`) - 1;
    return `${prefix}${PLACEHOLDER_OPEN}${index}${PLACEHOLDER_CLOSE}${trailing}`;
  });

  return restoreTokens(formatEmphasis(escapeHtml(text)), tokens);
}

function splitTableRow(line) {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split("|").map(cell => cell.trim());
}

function looksLikeTableStart(lines, index) {
  const line = lines[index]?.trim() ?? "";
  const next = lines[index + 1]?.trim() ?? "";
  if (!line.includes("|") || !next.includes("|")) return false;
  const cells = splitTableRow(next);
  return cells.length > 0 && cells.every(cell => TABLE_DELIMITER_RE.test(cell));
}

function isBlockStart(lines, index) {
  const line = lines[index] ?? "";
  if (FENCE_RE.test(line)) return true;
  if (HEADING_RE.test(line)) return true;
  if (HR_RE.test(line)) return true;
  if (/^\s{0,3}>\s?/.test(line)) return true;
  if (LIST_RE.test(line)) return true;
  if (/^( {4}|\t)/.test(line)) return true;
  if (looksLikeTableStart(lines, index)) return true;
  return false;
}

function renderCodeBlock(lines, start, end) {
  const opening = lines[start].match(FENCE_RE);
  const fence = opening?.[1]?.[0] ?? "`";
  const fenceLength = opening?.[1]?.length ?? 3;
  const language = (opening?.[2] ?? "").replace(/[^\w+#.-]/g, "");
  const code = [];
  let index = start + 1;
  while (index < end) {
    const closing = lines[index].match(/^\s*(`{3,}|~{3,})\s*$/);
    if (closing && closing[1][0] === fence && closing[1].length >= fenceLength) {
      index += 1;
      break;
    }
    code.push(lines[index]);
    index += 1;
  }
  const className = language ? ` class="language-${escapeHtml(language)}"` : "";
  return {
    html: `<pre class="mdCode"><code${className}>${escapeHtml(code.join("\n"))}</code></pre>`,
    next: index,
  };
}

function renderList(lines, start, end) {
  const first = lines[start].match(LIST_RE);
  if (!first) return null;
  const baseIndent = leadingIndent(first[1]);
  const ordered = /^\d/.test(first[2]);
  const startNumber = ordered ? Number.parseInt(first[2], 10) : 1;
  const items = [];
  let current = null;
  let index = start;

  while (index < end) {
    const line = lines[index];
    if (!line.trim()) {
      let next = index + 1;
      while (next < end && !lines[next].trim()) next += 1;
      const nextMatch = next < end ? lines[next].match(LIST_RE) : null;
      const nextIndent = next < end ? leadingIndent(lines[next]) : 0;
      if (next < end && (nextIndent > baseIndent || (nextMatch && leadingIndent(nextMatch[1]) >= baseIndent))) {
        if (current && nextMatch && leadingIndent(nextMatch[1]) > baseIndent) current.text += "\n";
        index += 1;
        continue;
      }
      break;
    }

    const match = line.match(LIST_RE);
    if (match) {
      const indent = leadingIndent(match[1]);
      if (indent < baseIndent) break;
      if (indent > baseIndent) {
        const nested = renderList(lines, index, end);
        if (nested && current) {
          current.nested += nested.html;
          index = nested.next;
          continue;
        }
      } else {
        if (/^\d/.test(match[2]) !== ordered) break;
        current = { text: match[3], nested: "" };
        items.push(current);
        index += 1;
        continue;
      }
    }

    if (current && leadingIndent(line) > baseIndent) {
      current.text += `${current.text ? "\n" : ""}${line.trim()}`;
      index += 1;
      continue;
    }
    break;
  }

  const tag = ordered ? "ol" : "ul";
  const startAttr = ordered && Number.isFinite(startNumber) && startNumber !== 1 ? ` start="${startNumber}"` : "";
  const body = items.map(item => {
    let text = item.text;
    let prefix = "";
    const task = text.match(/^\[([ xX])\]\s+(.*)$/);
    if (task) {
      prefix = `<input class="mdTask" type="checkbox" disabled${task[1].toLowerCase() === "x" ? " checked" : ""} /> `;
      text = task[2];
    }
    const linesHtml = text.split("\n").map(lineText => tokenizeInline(lineText)).join("<br>");
    return `<li>${prefix}${linesHtml}${item.nested}</li>`;
  }).join("");
  return { html: `<${tag}${startAttr}>${body}</${tag}>`, next: index };
}

function renderTable(lines, start, end) {
  const headers = splitTableRow(lines[start]);
  const alignments = splitTableRow(lines[start + 1]).map(cell => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return "";
  });
  const cell = (tag, content, index) => {
    const alignment = alignments[index] ? ` style="text-align:${alignments[index]}"` : "";
    return `<${tag}${alignment}>${tokenizeInline(content)}</${tag}>`;
  };
  const head = headers.map((header, index) => cell("th", header, index)).join("");
  const rows = [];
  let index = start + 2;
  while (index < end && lines[index].trim() && lines[index].includes("|")) {
    const cells = splitTableRow(lines[index]);
    while (cells.length < headers.length) cells.push("");
    rows.push(`<tr>${headers.map((_, cellIndex) => cell("td", cells[cellIndex] ?? "", cellIndex)).join("")}</tr>`);
    index += 1;
  }
  return {
    html: `<div class="mdTableWrap"><table class="mdTable"><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`,
    next: index,
  };
}

function renderBlocks(lines) {
  const output = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (FENCE_RE.test(line)) {
      const block = renderCodeBlock(lines, index, lines.length);
      output.push(block.html);
      index = block.next;
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      const level = heading[1].length;
      output.push(`<h${level}>${tokenizeInline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    // Setext 标题：上一行文字 + 下一行 === 或 ---。
    if (index + 1 < lines.length && /^\s*(=+|-+)\s*$/.test(lines[index + 1]) && line.trim() && !isBlockStart(lines, index)) {
      const level = lines[index + 1].includes("=") ? 1 : 2;
      output.push(`<h${level}>${tokenizeInline(line.trim())}</h${level}>`);
      index += 2;
      continue;
    }

    if (HR_RE.test(line)) {
      output.push("<hr />");
      index += 1;
      continue;
    }

    if (/^\s{0,3}>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length) {
        const match = lines[index].match(/^\s{0,3}>\s?(.*)$/);
        if (!match) break;
        quote.push(match[1]);
        index += 1;
      }
      output.push(`<blockquote>${renderBlocks(quote).join("")}</blockquote>`);
      continue;
    }

    if (looksLikeTableStart(lines, index)) {
      const table = renderTable(lines, index, lines.length);
      output.push(table.html);
      index = table.next;
      continue;
    }

    if (LIST_RE.test(line)) {
      const list = renderList(lines, index, lines.length);
      if (list) {
        output.push(list.html);
        index = list.next;
        continue;
      }
    }

    if (/^( {4}|\t)/.test(line)) {
      const code = [];
      while (index < lines.length && (/^( {4}|\t)/.test(lines[index]) || !lines[index].trim())) {
        if (!lines[index].trim()) {
          code.push("");
        } else {
          code.push(lines[index].replace(/^( {4}|\t)/, ""));
        }
        index += 1;
      }
      output.push(`<pre class="mdCode"><code>${escapeHtml(code.join("\n").replace(/\n+$/, ""))}</code></pre>`);
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim()) {
      if (paragraph.length && isBlockStart(lines, index)) break;
      paragraph.push(lines[index].trim());
      index += 1;
    }
    if (paragraph.length) output.push(`<p>${paragraph.map(tokenizeInline).join("<br>")}</p>`);
  }
  return output;
}

/** 将 Markdown 转成安全 HTML；只用于对话气泡等可信容器。 */
export function renderMarkdown(source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  return renderBlocks(lines).join("");
}
