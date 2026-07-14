import {
  countText,
  decodeBase64Utf8,
  decodeUrl,
  encodeBase64Utf8,
  encodeUrl,
  formatJson,
  getCurrentTimestamps,
  highlightJson,
  minifyJson,
  convertTimestamp,
} from "/tools-core.js";
import {
  HISTORY_STORAGE_KEY,
  addHistoryRecord,
  clearHistoryRecords,
  createHistoryRecord,
  createRestoreSnapshot,
  deleteHistoryRecord,
  filterHistoryRecords,
  parseHistoryWithStatus,
  serializeHistory,
} from "/history-core.js";
import { renderQr } from "/qr.js";

const tools = [
  { id: "qr", mark: "⌗", name: "链接转二维码", short: "二维码", description: "把链接变成清晰、可下载的二维码。", keywords: "链接 网址 二维码 qr code" },
  { id: "json", mark: "{ }", name: "JSON 格式化", short: "JSON", description: "校验、整理或压缩 JSON 数据。", keywords: "json 格式化 解析 压缩 校验" },
  { id: "base64", mark: "64", name: "Base64 编解码", short: "Base64", description: "安全处理中文、emoji 与普通文本。", keywords: "base64 编码 解码 中文" },
  { id: "url", mark: "%", name: "URL 编解码", short: "URL", description: "处理完整网址或单独的参数值。", keywords: "url uri encode decode 参数" },
  { id: "timestamp", mark: "◷", name: "时间戳转换", short: "时间戳", description: "在秒、毫秒和可读时间之间转换。", keywords: "时间戳 timestamp 秒 毫秒 utc iso" },
  { id: "text", mark: "¶", name: "文本统计", short: "文本", description: "实时统计字符、词、行与字节。", keywords: "文本 字数 统计 字符 单词 行数 字节" },
];

const JSON_HIGHLIGHT_MAX_CHARACTERS = 120_000;

const samples = {
  qr: "https://example.com/hello",
  json: '{"name":"轻舟工具","features":["JSON","Base64","二维码"],"private":true}',
  base64: "轻舟工具，让常用转换更轻松 🚤",
  url: "https://example.com/search?q=轻舟工具&from=首页",
  timestamp: "1767225600",
  text: "轻舟工具\nSimple tools, calmer work.\n让每一次转换都更轻松。",
};

const state = {
  active: "qr",
  qr: { input: "", generated: false, error: "" },
  json: { input: "", output: "", indent: "2", sortKeys: false, expanded: false, error: "" },
  base64: { input: "", output: "", direction: "encode", error: "" },
  url: { input: "", output: "", direction: "encode", mode: "full", error: "" },
  timestamp: { input: "", result: null, error: "" },
  text: { input: "", stats: countText(""), error: "" },
};

const searchInput = document.querySelector("#tool-search");
const toolNav = document.querySelector("#tool-nav");
const toolHeader = document.querySelector("#tool-header");
const toolContent = document.querySelector("#tool-content");
const dialogRoot = document.querySelector("#dialog-root");
const historyRoot = document.querySelector("#history-root");
const appShell = document.querySelector(".app-shell");
const toast = document.querySelector("#toast");
let jsonExpandTrigger = null;
let jsonMarkupCache = { source: null, html: "", highlighted: false };
let historyRecords = [];
let historyTrigger = null;
let historyStorageDisabled = false;
const historyUi = { open: false, filter: "all", confirmClear: false };

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const historyActionLabels = {
  qr: { generate: "生成二维码" },
  json: { format: "格式化", minify: "压缩" },
  base64: { encode: "编码", decode: "解码" },
  url: { encode: "编码", decode: "解码" },
  timestamp: { convert: "转换时间", now: "当前时间" },
};

function createHistoryId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `history-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function historyOptionsFor(toolId) {
  if (toolId === "json") {
    return { indent: state.json.indent, sortKeys: state.json.sortKeys };
  }
  if (toolId === "url") return { mode: state.url.mode };
  return {};
}

function isQuotaExceeded(error) {
  return error?.name === "QuotaExceededError" || error?.code === 22 || error?.code === 1014;
}

function initializeHistory() {
  try {
    const serialized = localStorage.getItem(HISTORY_STORAGE_KEY);
    const parsed = parseHistoryWithStatus(serialized);
    historyRecords = parsed.records;
    if (parsed.reset) {
      localStorage.removeItem(HISTORY_STORAGE_KEY);
      showToast("使用记录已重新初始化");
    }
  } catch {
    historyRecords = [];
    historyStorageDisabled = true;
    showToast("使用记录暂时仅在本页面可用");
  }
}

function persistHistory(records, { protectedId = null } = {}) {
  historyRecords = records;
  if (historyStorageDisabled) return false;

  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, serializeHistory(historyRecords));
    return true;
  } catch (error) {
    if (isQuotaExceeded(error)) {
      const oldest = [...historyRecords]
        .reverse()
        .find((record) => record.id !== protectedId);
      if (oldest) {
        historyRecords = deleteHistoryRecord(historyRecords, oldest.id);
        try {
          localStorage.setItem(HISTORY_STORAGE_KEY, serializeHistory(historyRecords));
          showToast("已清理最早记录以释放空间");
          return true;
        } catch {
          // Fall through to memory-only mode after the single allowed retry.
        }
      }
    }

    historyStorageDisabled = true;
    showToast("记录无法继续持久保存，本页面仍可查看");
    return false;
  }
}

function updateHistoryCount() {
  const count = toolHeader.querySelector("[data-history-count]");
  if (count) {
    count.textContent = String(historyRecords.length);
    count.setAttribute("aria-label", `${historyRecords.length} 条记录`);
  }
}

function recordSuccessfulOperation(toolId, action) {
  const input = String(state[toolId]?.input ?? "");
  if (!input.length) return;

  try {
    const record = createHistoryRecord(
      { tool: toolId, input, action, options: historyOptionsFor(toolId) },
      { now: Date.now(), id: createHistoryId() },
    );
    const nextRecords = addHistoryRecord(historyRecords, record);
    persistHistory(nextRecords, { protectedId: nextRecords[0]?.id ?? null });
    updateHistoryCount();
  } catch (error) {
    if (error?.code === "INPUT_TOO_LARGE") {
      showToast("内容较大，本次未保存记录");
      return;
    }
    showToast("本次使用记录未能保存");
  }
}

function historyDateLabel(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (startDate === startToday) return "今天";
  if (startDate === startToday - 86_400_000) return "昨天";
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(date);
}

function historyTimeLabel(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(timestamp));
}

function historySummary(input) {
  const compact = String(input).replace(/\s+/gu, " ").trim();
  if (!compact) return "（空白内容）";
  return compact.length > 88 ? `${compact.slice(0, 88)}…` : compact;
}

function historyOperationLabel(record) {
  const tool = tools.find((item) => item.id === record.tool);
  const action = historyActionLabels[record.tool]?.[record.action] ?? record.action;
  return `${tool?.short ?? record.tool} · ${action}`;
}

function renderHistoryDrawer() {
  if (!historyUi.open) {
    historyRoot.replaceChildren();
    syncOverlayState();
    return;
  }

  const currentTool = tools.find((item) => item.id === state.active);
  const filterTool = historyUi.filter === "current" ? state.active : null;
  const filtered = filterHistoryRecords(historyRecords, filterTool);
  const groups = new Map();
  for (const record of filtered) {
    const label = historyDateLabel(record.createdAt);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(record);
  }

  const groupMarkup = [...groups.entries()].map(([label, records]) => `
    <section class="history-group" aria-labelledby="history-group-${escapeHtml(records[0].id)}">
      <h3 class="history-group-title" id="history-group-${escapeHtml(records[0].id)}">${escapeHtml(label)}</h3>
      ${records.map((record) => {
        const tool = tools.find((item) => item.id === record.tool);
        const operation = historyOperationLabel(record);
        const time = historyTimeLabel(record.createdAt);
        return `<article class="history-card">
          <button class="history-restore" type="button" data-action="history-restore" data-history-id="${escapeHtml(record.id)}" aria-label="恢复${escapeHtml(operation)}记录">
            <span class="history-card-top">
              <span class="history-tool-mark" aria-hidden="true">${escapeHtml(tool?.mark ?? "•")}</span>
              <span class="history-operation">${escapeHtml(operation)}</span>
              <time class="history-time" datetime="${new Date(record.createdAt).toISOString()}">${escapeHtml(time)}</time>
            </span>
            <span class="history-summary">${escapeHtml(historySummary(record.input))}</span>
          </button>
          <button class="history-delete" type="button" data-action="history-delete" data-history-id="${escapeHtml(record.id)}" aria-label="删除${escapeHtml(operation)} ${escapeHtml(time)}的记录">×</button>
        </article>`;
      }).join("")}
    </section>`).join("");

  const emptyMarkup = `<div class="history-empty">
    <span class="history-empty-mark" aria-hidden="true">◴</span>
    <strong>${historyUi.filter === "current" ? "当前工具还没有记录" : "还没有使用记录"}</strong>
    <p>${historyUi.filter === "current" && state.active === "text" ? "文本统计不会保存记录。" : "成功使用工具后，记录会自动出现在这里。"}</p>
  </div>`;

  const clearControls = historyUi.confirmClear
    ? `<span class="history-confirm-actions" role="group" aria-label="确认清空全部记录">
        <button class="history-confirm" type="button" data-action="history-confirm-clear">确认清空</button>
        <button class="history-cancel" type="button" data-action="history-cancel-clear">取消</button>
      </span>`
    : `<button class="history-clear" type="button" data-action="history-clear" ${historyRecords.length ? "" : "disabled"}>全部清空</button>`;

  historyRoot.innerHTML = `
    <div class="history-backdrop" data-history-backdrop>
      <aside class="history-drawer" id="history-drawer" role="dialog" aria-modal="true" aria-labelledby="history-title">
        <header class="history-header">
          <div class="history-title-row">
            <div class="history-title">
              <span class="history-title-mark" aria-hidden="true">◴</span>
              <div class="history-title-copy">
                <h2 id="history-title">使用记录</h2>
                <p>共 ${historyRecords.length} 条，可点击恢复</p>
              </div>
            </div>
            <div class="history-header-actions">
              ${clearControls}
              <button class="history-close" type="button" data-action="history-close" aria-label="关闭使用记录">×</button>
            </div>
          </div>
          <div class="history-privacy"><span aria-hidden="true">◎</span><p>记录仅保存在此浏览器，不会上传。</p></div>
        </header>
        <nav class="history-filters" aria-label="筛选使用记录">
          <button class="history-filter ${historyUi.filter === "all" ? "is-active" : ""}" type="button" data-action="history-filter" data-value="all" aria-pressed="${historyUi.filter === "all"}">全部记录</button>
          <button class="history-filter ${historyUi.filter === "current" ? "is-active" : ""}" type="button" data-action="history-filter" data-value="current" aria-pressed="${historyUi.filter === "current"}">当前工具 · ${escapeHtml(currentTool?.short ?? "")}</button>
        </nav>
        <div class="history-content">${groupMarkup ? `<div class="history-groups">${groupMarkup}</div>` : emptyMarkup}</div>
      </aside>
    </div>`;
  syncOverlayState();
}

function openHistoryDrawer(trigger) {
  closeJsonDialog({ restoreFocus: false });
  historyTrigger = trigger;
  trigger.setAttribute("aria-expanded", "true");
  historyUi.open = true;
  historyUi.confirmClear = false;
  renderHistoryDrawer();
  requestAnimationFrame(() => historyRoot.querySelector('[data-action="history-close"]')?.focus());
}

function closeHistoryDrawer({ restoreFocus = true } = {}) {
  if (!historyUi.open) return;
  historyTrigger?.setAttribute("aria-expanded", "false");
  historyUi.open = false;
  historyUi.confirmClear = false;
  renderHistoryDrawer();
  if (restoreFocus) {
    requestAnimationFrame(() => {
      const fallback = toolHeader.querySelector('[data-action="history-open"]');
      (historyTrigger?.isConnected ? historyTrigger : fallback)?.focus();
    });
  }
  historyTrigger = null;
}

function syncOverlayState() {
  const hasOverlay = Boolean(state.json.expanded || historyUi.open);
  document.body.classList.toggle("dialog-open", hasOverlay);
  appShell.inert = hasOverlay;
}

function trapFocus(container, event) {
  if (event.key !== "Tab" || !container) return false;
  const focusable = [...container.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')];
  if (!focusable.length) return false;
  const currentIndex = focusable.indexOf(document.activeElement);
  const nextIndex = event.shiftKey
    ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
    : (currentIndex < 0 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
  event.preventDefault();
  focusable[nextIndex].focus();
  return true;
}

function renderNavigation(query = "") {
  const normalized = query.trim().toLowerCase();
  const filtered = tools.filter((tool) => `${tool.name} ${tool.keywords}`.toLowerCase().includes(normalized));
  toolNav.innerHTML = filtered.length
    ? filtered.map((tool) => `
      <button class="tool-button ${tool.id === state.active ? "is-active" : ""}" type="button" data-tool="${tool.id}" aria-pressed="${tool.id === state.active}">
        <span class="tool-mark" aria-hidden="true">${tool.mark}</span>
        <span><strong>${tool.name}</strong><small>${tool.description}</small></span>
      </button>`).join("")
    : '<p class="nav-empty">没有匹配的工具</p>';
}

function panel(title, subtitle, body, className = "") {
  return `<section class="panel ${className}">
    <div class="panel-header"><div><h2>${title}</h2>${subtitle ? `<p>${subtitle}</p>` : ""}</div></div>
    <div class="panel-body">${body}</div>
  </section>`;
}

function actionButton(label, action, style = "secondary-button", attributes = "") {
  return `<button class="${style}" type="button" data-action="${action}" ${attributes}>${label}</button>`;
}

function fieldError(message, id) {
  return message ? `<p class="error" id="${id}" role="alert">${escapeHtml(message)}</p>` : `<p class="error is-empty" id="${id}" aria-hidden="true"></p>`;
}

function getJsonMarkup(value) {
  if (jsonMarkupCache.source !== value) {
    const highlighted = value.length <= JSON_HIGHLIGHT_MAX_CHARACTERS;
    jsonMarkupCache = {
      source: value,
      html: highlighted ? highlightJson(value) : escapeHtml(value),
      highlighted,
    };
  }
  return jsonMarkupCache;
}

function renderQrTool() {
  const inputPanel = panel("输入链接", "支持 http:// 和 https:// 链接", `
    <label class="field-label" for="qr-input">链接地址</label>
    <input class="field" id="qr-input" data-field="input" type="url" inputmode="url" autocomplete="url" placeholder="https://example.com" aria-describedby="qr-error" aria-invalid="${Boolean(state.qr.error)}" />
    ${fieldError(state.qr.error, "qr-error")}
    <div class="control-row">
      ${actionButton("生成二维码", "run", "primary-button")}
      ${actionButton("填入示例", "sample", "secondary-button")}
      ${actionButton("清空", "clear", "ghost-button")}
    </div>
  `);
  const preview = state.qr.generated
    ? '<canvas id="qr-canvas" width="320" height="320" aria-label="生成的二维码"></canvas>'
    : '<div class="empty-state"><span aria-hidden="true">⌗</span><strong>二维码会显示在这里</strong><p>输入链接后点击生成，整个过程只在浏览器中完成。</p></div>';
  const outputPanel = panel("二维码预览", "适合分享与扫码打开", `
    <div class="qr-preview">${preview}</div>
    <div class="control-row is-centered">
      ${actionButton("下载 PNG", "download", "secondary-button", state.qr.generated ? "" : "disabled")}
    </div>
  `, "panel-accent");
  return `<div class="tool-layout">${inputPanel}${outputPanel}</div>`;
}

function renderJsonTool() {
  const indentButtons = [["2", "2 空格"], ["4", "4 空格"], ["tab", "Tab"]]
    .map(([value, label]) => `<button type="button" data-action="json-indent" data-value="${value}" class="${state.json.indent === value ? "is-active" : ""}" aria-pressed="${state.json.indent === value}">${label}</button>`).join("");
  const left = panel("原始 JSON", "粘贴或输入需要处理的数据", `
    <div class="control-row is-between"><div class="segmented" aria-label="缩进方式">${indentButtons}</div>
      <label class="check-control"><input type="checkbox" data-field="sortKeys" ${state.json.sortKeys ? "checked" : ""} /> 排序键名</label></div>
    <label class="sr-only" for="json-input">原始 JSON</label>
    <textarea class="field code-field" id="json-input" data-field="input" spellcheck="false" placeholder='{"hello":"world"}' aria-describedby="json-error" aria-invalid="${Boolean(state.json.error)}"></textarea>
    ${fieldError(state.json.error, "json-error")}
    <div class="control-row">${actionButton("格式化", "run", "primary-button")}${actionButton("压缩", "minify", "secondary-button")}${actionButton("示例", "sample", "ghost-button")}${actionButton("清空", "clear", "ghost-button")}</div>
  `);
  const jsonMarkup = state.json.output ? getJsonMarkup(state.json.output) : null;
  const highlightedOutput = jsonMarkup
    ? `${jsonMarkup.highlighted ? "" : '<p class="json-highlight-note" role="status">内容较大，已暂停语法着色以保持流畅；结果仍会完整展示。</p>'}<pre class="json-code-view" id="json-output" tabindex="0" aria-label="JSON 处理结果"><code>${jsonMarkup.html}</code></pre>`
    : '<div class="json-output-empty" id="json-output" aria-label="JSON 处理结果">处理结果会显示在这里</div>';
  const right = panel("处理结果", "结果可直接复制使用", `
    ${highlightedOutput}
    <div class="control-row">
      ${actionButton('<span aria-hidden="true">↗</span> 放大查看', "json-expand", "secondary-button", state.json.output ? "aria-haspopup=\"dialog\" aria-controls=\"json-result-dialog\" aria-expanded=\"false\"" : "disabled")}
      ${actionButton("复制结果", "copy", "secondary-button", state.json.output ? "" : "disabled")}
    </div>
  `, "panel-accent");
  return `<div class="tool-layout">${left}${right}</div>`;
}

function renderJsonDialog() {
  const shouldOpen = state.active === "json" && state.json.expanded && state.json.output;
  if (!shouldOpen) {
    dialogRoot.replaceChildren();
    syncOverlayState();
    return;
  }

  const jsonMarkup = getJsonMarkup(state.json.output);
  dialogRoot.innerHTML = `
    <div class="json-dialog-backdrop" data-json-dialog-backdrop>
      <section class="json-dialog" id="json-result-dialog" role="dialog" aria-modal="true" aria-labelledby="json-dialog-title">
        <header class="json-dialog-header">
          <div>
            <p class="eyebrow">放大查看</p>
            <h2 id="json-dialog-title">JSON 处理结果</h2>
            ${jsonMarkup.highlighted ? "" : '<p class="json-dialog-hint">大内容已暂停语法着色，以保证浏览流畅。</p>'}
          </div>
          <div class="json-dialog-actions">
            ${actionButton("复制结果", "json-dialog-copy", "secondary-button")}
            <button class="json-dialog-close" type="button" data-action="json-dialog-close" aria-label="关闭放大查看">×</button>
          </div>
        </header>
        <div class="json-dialog-body">
          <pre class="json-code-view is-expanded" tabindex="0" aria-label="放大的 JSON 处理结果"><code>${jsonMarkup.html}</code></pre>
        </div>
      </section>
    </div>`;
  syncOverlayState();
}

function openJsonDialog(trigger) {
  if (!state.json.output) return;
  closeHistoryDrawer({ restoreFocus: false });
  jsonExpandTrigger = trigger;
  trigger.setAttribute("aria-expanded", "true");
  state.json.expanded = true;
  renderJsonDialog();
  requestAnimationFrame(() => dialogRoot.querySelector('[data-action="json-dialog-close"]')?.focus());
}

function closeJsonDialog({ restoreFocus = true } = {}) {
  if (!state.json.expanded) return;
  jsonExpandTrigger?.setAttribute("aria-expanded", "false");
  state.json.expanded = false;
  renderJsonDialog();
  if (restoreFocus) {
    requestAnimationFrame(() => {
      const fallback = toolContent.querySelector('[data-action="json-expand"]');
      (jsonExpandTrigger?.isConnected ? jsonExpandTrigger : fallback)?.focus();
    });
  }
  jsonExpandTrigger = null;
}

function renderTwoWayTextTool(toolId, options) {
  const current = state[toolId];
  const direction = `<div class="segmented" aria-label="转换方向">
    <button type="button" data-action="direction" data-value="encode" class="${current.direction === "encode" ? "is-active" : ""}" aria-pressed="${current.direction === "encode"}">编码</button>
    <button type="button" data-action="direction" data-value="decode" class="${current.direction === "decode" ? "is-active" : ""}" aria-pressed="${current.direction === "decode"}">解码</button>
  </div>`;
  const mode = toolId === "url" ? `<div class="segmented" aria-label="处理范围">
    <button type="button" data-action="url-mode" data-value="full" class="${current.mode === "full" ? "is-active" : ""}" aria-pressed="${current.mode === "full"}">完整 URL</button>
    <button type="button" data-action="url-mode" data-value="component" class="${current.mode === "component" ? "is-active" : ""}" aria-pressed="${current.mode === "component"}">参数值</button>
  </div>` : "";
  const left = panel(options.inputTitle, options.inputHint, `
    <div class="control-row is-between">${direction}${mode}</div>
    <label class="sr-only" for="${toolId}-input">${options.inputTitle}</label>
    <textarea class="field code-field" id="${toolId}-input" data-field="input" spellcheck="false" placeholder="${options.placeholder}" aria-describedby="${toolId}-error" aria-invalid="${Boolean(current.error)}"></textarea>
    ${fieldError(current.error, `${toolId}-error`)}
    <div class="control-row">${actionButton("立即转换", "run", "primary-button")}${actionButton("示例", "sample", "secondary-button")}${actionButton("清空", "clear", "ghost-button")}</div>
  `);
  const right = panel("转换结果", options.outputHint, `
    <label class="sr-only" for="${toolId}-output">转换结果</label>
    <textarea class="field code-field output-field" id="${toolId}-output" data-output readonly placeholder="转换结果会显示在这里"></textarea>
    <div class="control-row">${actionButton("复制结果", "copy", "secondary-button", current.output ? "" : "disabled")}</div>
  `, "panel-accent");
  return `<div class="tool-layout">${left}${right}</div>`;
}

function renderTimestampTool() {
  const result = state.timestamp.result;
  const resultMarkup = result ? `<div class="result-list">
    ${[
      ["秒级时间戳", result.seconds],
      ["毫秒级时间戳", result.milliseconds],
      ["本地时间", result.local],
      ["UTC 时间", result.utc],
      ["ISO 8601", result.iso],
    ].map(([label, value]) => `<div class="result-item"><span>${label}</span><strong>${escapeHtml(value)}</strong><button type="button" class="copy-mini" data-copy-value="${escapeHtml(value)}" aria-label="复制${label}">复制</button></div>`).join("")}
  </div>` : '<div class="empty-state"><span aria-hidden="true">◷</span><strong>可读时间会显示在这里</strong><p>自动识别 10 位秒级与 13 位毫秒级时间戳。</p></div>';
  const left = panel("输入时间戳", "支持 10 位秒级或 13 位毫秒级", `
    <label class="field-label" for="timestamp-input">时间戳</label>
    <input class="field code-field" id="timestamp-input" data-field="input" inputmode="numeric" placeholder="1767225600" aria-describedby="timestamp-error" aria-invalid="${Boolean(state.timestamp.error)}" />
    ${fieldError(state.timestamp.error, "timestamp-error")}
    <div class="control-row">${actionButton("转换时间", "run", "primary-button")}${actionButton("使用当前时间", "now", "secondary-button")}${actionButton("清空", "clear", "ghost-button")}</div>
  `);
  const right = panel("时间结果", "同时展示本地、UTC 与 ISO 格式", resultMarkup, "panel-accent");
  return `<div class="tool-layout">${left}${right}</div>`;
}

function renderTextTool() {
  const stats = state.text.stats;
  const statItems = [
    ["字符", stats.characters],
    ["去空格字符", stats.nonWhitespaceCharacters],
    ["词数", stats.words],
    ["行数", stats.lines],
    ["UTF-8 字节", stats.bytes],
  ];
  const left = panel("输入文本", "统计会随着输入实时更新", `
    <label class="sr-only" for="text-input">需要统计的文本</label>
    <textarea class="field text-field" id="text-input" data-field="input" placeholder="在这里输入或粘贴文本…"></textarea>
    <div class="control-row">${actionButton("填入示例", "sample", "secondary-button")}${actionButton("清空", "clear", "ghost-button")}</div>
  `);
  const right = panel("统计结果", "中文、英文、数字与 emoji 均按 UTF-8 处理", `<div class="stat-grid">${statItems.map(([label, value]) => `<div class="stat-card"><strong>${value}</strong><span>${label}</span></div>`).join("")}</div>
    <div class="output-block"><span class="status-pill">本地实时计算</span><p>连续英文或数字算一个词，每个汉字算一个词。</p></div>`, "panel-accent");
  return `<div class="tool-layout">${left}${right}</div>`;
}

function renderWorkspace() {
  const tool = tools.find((item) => item.id === state.active);
  toolHeader.innerHTML = `<div class="workspace-title"><span class="workspace-mark" aria-hidden="true">${tool.mark}</span><div><p class="eyebrow">当前工具</p><h1>${tool.name}</h1><p>${tool.description}</p></div></div>
    <div class="workspace-actions">
      <button class="history-trigger" type="button" data-action="history-open" aria-haspopup="dialog" aria-controls="history-drawer" aria-expanded="${historyUi.open}">
        <span class="history-trigger-mark" aria-hidden="true">◴</span>
        <span>使用记录</span>
        <span class="history-count" data-history-count aria-label="${historyRecords.length} 条记录">${historyRecords.length}</span>
      </button>
      <span class="status-pill"><span aria-hidden="true">●</span> 数据仅在本地处理</span>
    </div>`;
  if (state.active === "qr") toolContent.innerHTML = renderQrTool();
  if (state.active === "json") toolContent.innerHTML = renderJsonTool();
  if (state.active === "base64") toolContent.innerHTML = renderTwoWayTextTool("base64", { inputTitle: "输入文本", inputHint: "编码支持中文与 emoji，解码会严格校验", placeholder: "输入原文或 Base64 内容", outputHint: "UTF-8 安全转换" });
  if (state.active === "url") toolContent.innerHTML = renderTwoWayTextTool("url", { inputTitle: "输入 URL", inputHint: "可处理完整网址或单独参数值", placeholder: "https://example.com/search?q=轻舟工具", outputHint: "保留正确的 URL 结构" });
  if (state.active === "timestamp") toolContent.innerHTML = renderTimestampTool();
  if (state.active === "text") toolContent.innerHTML = renderTextTool();

  hydrateFields();
  if (state.active === "qr" && state.qr.generated) drawQr();
  renderJsonDialog();
}

function hydrateFields() {
  const current = state[state.active];
  toolContent.querySelectorAll("[data-field]").forEach((field) => {
    const key = field.dataset.field;
    if (field.type === "checkbox") field.checked = Boolean(current[key]);
    else field.value = current[key] ?? "";
  });
  const output = toolContent.querySelector("[data-output]");
  if (output) output.value = current.output || "";
}

function drawQr() {
  const canvas = document.querySelector("#qr-canvas");
  if (!canvas) return;
  try {
    renderQr(canvas, state.qr.input, { size: 320, color: "#173f38", background: "#ffffff" });
  } catch (error) {
    state.qr.generated = false;
    state.qr.error = error instanceof Error ? error.message : "二维码生成失败";
    renderWorkspace();
  }
}

function runCurrentTool({ recordHistory = true } = {}) {
  const current = state[state.active];
  const toolId = state.active;
  let historyAction = null;
  current.error = "";
  try {
    if (toolId === "qr") {
      const url = new URL(current.input);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error("请输入以 http:// 或 https:// 开头的链接");
      current.generated = true;
      historyAction = "generate";
    } else if (toolId === "json") {
      const indent = current.indent === "tab" ? "\t" : Number(current.indent);
      current.output = formatJson(current.input, { indent, sortKeys: current.sortKeys });
      historyAction = "format";
    } else if (toolId === "base64") {
      current.output = current.direction === "encode" ? encodeBase64Utf8(current.input) : decodeBase64Utf8(current.input);
      historyAction = current.direction;
    } else if (toolId === "url") {
      current.output = current.direction === "encode" ? encodeUrl(current.input, current.mode) : decodeUrl(current.input, current.mode);
      historyAction = current.direction;
    } else if (toolId === "timestamp") {
      current.result = convertTimestamp(current.input);
      historyAction = "convert";
    } else if (toolId === "text") {
      current.stats = countText(current.input);
    }

    if (recordHistory && historyAction && toolId !== "qr") {
      recordSuccessfulOperation(toolId, historyAction);
    }
    renderWorkspace();
    if (toolId === "qr" && !state.qr.generated) return false;
    if (recordHistory && toolId === "qr" && historyAction && state.qr.generated) {
      recordSuccessfulOperation(toolId, historyAction);
    }
    return true;
  } catch (error) {
    current.error = error instanceof Error ? error.message : "处理失败，请检查输入";
    renderWorkspace();
    return false;
  }
}

function minifyCurrentJson({ recordHistory = true } = {}) {
  state.json.error = "";
  try {
    state.json.output = minifyJson(state.json.input, { sortKeys: state.json.sortKeys });
    if (recordHistory) recordSuccessfulOperation("json", "minify");
    renderWorkspace();
    return true;
  } catch (error) {
    state.json.error = error instanceof Error ? error.message : "JSON 处理失败";
    renderWorkspace();
    return false;
  }
}

function useCurrentTimestamp({ recordHistory = true } = {}) {
  state.timestamp.error = "";
  try {
    state.timestamp.result = getCurrentTimestamps();
    state.timestamp.input = String(state.timestamp.result.milliseconds);
    if (recordHistory) recordSuccessfulOperation("timestamp", "now");
    renderWorkspace();
    return true;
  } catch (error) {
    state.timestamp.error = error instanceof Error ? error.message : "获取当前时间失败";
    renderWorkspace();
    return false;
  }
}

function clearCurrentTool() {
  if (state.active === "json") closeJsonDialog({ restoreFocus: false });
  const current = state[state.active];
  current.input = "";
  current.error = "";
  if ("output" in current) current.output = "";
  if ("generated" in current) current.generated = false;
  if ("result" in current) current.result = null;
  if (state.active === "text") current.stats = countText("");
  renderWorkspace();
}

function removeHistoryRecord(id, { announce = true } = {}) {
  const nextRecords = deleteHistoryRecord(historyRecords, id);
  if (nextRecords.length === historyRecords.length) return null;
  const persisted = persistHistory(nextRecords);
  updateHistoryCount();
  renderHistoryDrawer();
  if (announce) {
    showToast(persisted ? "记录已删除" : "已从本页面移除，浏览器存储暂未更新");
  }
  return persisted;
}

function clearAllHistory() {
  historyRecords = clearHistoryRecords();
  let persisted = false;
  try {
    localStorage.removeItem(HISTORY_STORAGE_KEY);
    historyStorageDisabled = false;
    persisted = true;
  } catch {
    historyStorageDisabled = true;
  }
  historyUi.confirmClear = false;
  updateHistoryCount();
  renderHistoryDrawer();
  showToast(persisted ? "使用记录已清空" : "本页面记录已清空，浏览器存储暂未更新");
}

function resetToolResult(toolId) {
  const current = state[toolId];
  current.error = "";
  if ("output" in current) current.output = "";
  if ("generated" in current) current.generated = false;
  if ("result" in current) current.result = null;
  if (toolId === "json") current.expanded = false;
}

function restoreHistoryRecord(id) {
  const record = historyRecords.find((item) => item.id === id);
  if (!record) {
    showToast("这条记录已不存在");
    renderHistoryDrawer();
    return;
  }

  let snapshot;
  try {
    snapshot = createRestoreSnapshot(record);
  } catch {
    const removedPersisted = removeHistoryRecord(id, { announce: false });
    showToast(removedPersisted ? "记录已损坏，已自动移除" : "损坏记录已从本页面移除");
    return;
  }

  closeHistoryDrawer({ restoreFocus: false });
  closeJsonDialog({ restoreFocus: false });
  state.active = snapshot.tool;
  resetToolResult(snapshot.tool);
  state[snapshot.tool].input = snapshot.input;

  if (snapshot.tool === "json") {
    state.json.indent = snapshot.options.indent;
    state.json.sortKeys = snapshot.options.sortKeys;
  }
  if (snapshot.tool === "base64" || snapshot.tool === "url") {
    state[snapshot.tool].direction = snapshot.action;
  }
  if (snapshot.tool === "url") state.url.mode = snapshot.options.mode;

  renderNavigation(searchInput.value);
  let restored = false;
  if (snapshot.tool === "json" && snapshot.action === "minify") {
    restored = minifyCurrentJson({ recordHistory: false });
  } else {
    restored = runCurrentTool({ recordHistory: false });
  }

  if (!restored) {
    const removedPersisted = removeHistoryRecord(id, { announce: false });
    document.querySelector("#workspace")?.focus({ preventScroll: true });
    showToast(removedPersisted ? "记录无法恢复，已自动移除" : "无法恢复的记录已从本页面移除");
    return;
  }

  document.querySelector("#workspace")?.focus({ preventScroll: true });
  showToast("已恢复当时的内容和设置");
}

async function copyText(value) {
  if (!value) return;
  let copied = false;
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(String(value));
    copied = true;
  } catch {
    const previousFocus = document.activeElement;
    const helper = document.createElement("textarea");
    helper.value = String(value);
    helper.style.position = "fixed";
    helper.style.left = "-9999px";
    helper.style.opacity = "0";
    helper.setAttribute("aria-hidden", "true");
    helper.tabIndex = -1;
    (state.json.expanded ? dialogRoot : document.body).append(helper);
    try {
      helper.select();
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    } finally {
      helper.remove();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    }
  }
  showToast(copied ? "已复制到剪贴板" : "复制失败，请手动选择内容");
  return copied;
}

let toastTimer;
function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 1800);
}

toolNav.addEventListener("click", (event) => {
  const button = event.target.closest("[data-tool]");
  if (!button) return;
  closeHistoryDrawer({ restoreFocus: false });
  closeJsonDialog({ restoreFocus: false });
  state.active = button.dataset.tool;
  renderNavigation(searchInput.value);
  renderWorkspace();
  document.querySelector("#workspace")?.focus({ preventScroll: true });
});

searchInput.addEventListener("input", () => renderNavigation(searchInput.value));

toolHeader.addEventListener("click", (event) => {
  const button = event.target.closest('[data-action="history-open"]');
  if (button) openHistoryDrawer(button);
});

toolContent.addEventListener("input", (event) => {
  const field = event.target.closest("[data-field]");
  if (!field) return;
  const current = state[state.active];
  current[field.dataset.field] = field.type === "checkbox" ? field.checked : field.value;
  current.error = "";
  if (state.active === "qr" && field.dataset.field === "input" && current.generated) {
    current.generated = false;
    const preview = toolContent.querySelector(".qr-preview");
    const download = toolContent.querySelector('[data-action="download"]');
    if (preview) preview.innerHTML = '<div class="empty-state"><span aria-hidden="true">⌗</span><strong>链接已变化</strong><p>请重新生成二维码，确保扫码内容与当前输入一致。</p></div>';
    if (download) download.disabled = true;
  }
  if (state.active === "text" && field.dataset.field === "input") {
    current.stats = countText(current.input);
    const stats = toolContent.querySelectorAll(".stat-card strong");
    const values = [current.stats.characters, current.stats.nonWhitespaceCharacters, current.stats.words, current.stats.lines, current.stats.bytes];
    stats.forEach((node, index) => { node.textContent = values[index]; });
  }
});

toolContent.addEventListener("change", (event) => {
  const field = event.target.closest("[data-field]");
  if (!field) return;
  state[state.active][field.dataset.field] = field.type === "checkbox" ? field.checked : field.value;
});

toolContent.addEventListener("click", async (event) => {
  const copyValueButton = event.target.closest("[data-copy-value]");
  if (copyValueButton) {
    await copyText(copyValueButton.dataset.copyValue);
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "run") runCurrentTool();
  if (action === "minify") minifyCurrentJson();
  if (action === "clear") clearCurrentTool();
  if (action === "json-expand") openJsonDialog(button);
  if (action === "sample") {
    const current = state[state.active];
    current.input = samples[state.active];
    current.error = "";
    if (state.active === "text") current.stats = countText(current.input);
    renderWorkspace();
  }
  if (action === "copy") await copyText(state[state.active].output);
  if (action === "direction") {
    state[state.active].direction = button.dataset.value;
    state[state.active].error = "";
    state[state.active].output = "";
    renderWorkspace();
  }
  if (action === "url-mode") {
    state.url.mode = button.dataset.value;
    state.url.error = "";
    state.url.output = "";
    renderWorkspace();
  }
  if (action === "json-indent") {
    state.json.indent = button.dataset.value;
    renderWorkspace();
  }
  if (action === "now") {
    useCurrentTimestamp();
  }
  if (action === "download") {
    const canvas = document.querySelector("#qr-canvas");
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return showToast("下载失败，请重试");
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "lightboat-qr.png";
      link.click();
      URL.revokeObjectURL(link.href);
      showToast("二维码已下载");
    }, "image/png");
  }
});

dialogRoot.addEventListener("click", async (event) => {
  if (event.target.matches("[data-json-dialog-backdrop]")) {
    closeJsonDialog();
    return;
  }

  const button = event.target.closest("[data-action]");
  if (!button) return;
  if (button.dataset.action === "json-dialog-close") closeJsonDialog();
  if (button.dataset.action === "json-dialog-copy") await copyText(state.json.output);
});

historyRoot.addEventListener("click", (event) => {
  if (event.target.matches("[data-history-backdrop]")) {
    closeHistoryDrawer();
    return;
  }

  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;

  if (action === "history-close") closeHistoryDrawer();
  if (action === "history-restore") restoreHistoryRecord(button.dataset.historyId);
  if (action === "history-delete") {
    removeHistoryRecord(button.dataset.historyId);
    requestAnimationFrame(() => {
      const next = historyRoot.querySelector('[data-action="history-delete"]')
        ?? historyRoot.querySelector('[data-action="history-close"]');
      next?.focus();
    });
  }
  if (action === "history-filter") {
    historyUi.filter = button.dataset.value;
    historyUi.confirmClear = false;
    renderHistoryDrawer();
    requestAnimationFrame(() => historyRoot.querySelector(`[data-action="history-filter"][data-value="${historyUi.filter}"]`)?.focus());
  }
  if (action === "history-clear") {
    historyUi.confirmClear = true;
    renderHistoryDrawer();
    requestAnimationFrame(() => historyRoot.querySelector('[data-action="history-confirm-clear"]')?.focus());
  }
  if (action === "history-cancel-clear") {
    historyUi.confirmClear = false;
    renderHistoryDrawer();
    requestAnimationFrame(() => historyRoot.querySelector('[data-action="history-clear"]')?.focus());
  }
  if (action === "history-confirm-clear") {
    clearAllHistory();
    requestAnimationFrame(() => historyRoot.querySelector('[data-action="history-close"]')?.focus());
  }
});

document.addEventListener("keydown", (event) => {
  if (historyUi.open) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeHistoryDrawer();
      return;
    }
    trapFocus(historyRoot.querySelector('[role="dialog"]'), event);
    return;
  }

  if (state.json.expanded) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeJsonDialog();
      return;
    }
    trapFocus(dialogRoot.querySelector('[role="dialog"]'), event);
    return;
  }

  const modifier = event.metaKey || event.ctrlKey;
  if (modifier && event.key.toLowerCase() === "k") {
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
  if (modifier && event.key === "Enter") {
    event.preventDefault();
    runCurrentTool();
  }
});

initializeHistory();
renderNavigation();
renderWorkspace();
