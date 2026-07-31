const openButton = document.querySelector("#icon-validity-open-button");
const dialog = document.querySelector("#icon-validity-dialog");
const closeButton = document.querySelector("#icon-validity-close");
const rescanButton = document.querySelector("#icon-validity-rescan");
const deleteAllButton = document.querySelector("#icon-validity-delete-all");
const summary = document.querySelector("#icon-validity-summary");
const note = document.querySelector("#icon-validity-note");
const list = document.querySelector("#icon-validity-list");
const empty = document.querySelector("#icon-validity-empty");

const MAX_CONCURRENCY = 8;
const LOAD_TIMEOUT = 12000;
let invalidEntries = [];
let activeScan = null;
let scanSequence = 0;
let removalSaving = false;
let resultRenderFrame = 0;

function setSummary(message, state = "") {
  summary.textContent = message;
  summary.className = `icon-validity-summary${state ? ` is-${state}` : ""}`;
}

function setScanControls(scanning) {
  const busy = scanning || removalSaving;
  rescanButton.disabled = busy;
  openButton.disabled = busy;
  deleteAllButton.disabled = busy || invalidEntries.length === 0;
  list.querySelectorAll("button").forEach((button) => { button.disabled = busy; });
}

function getUrlError(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(parsed.protocol)) return "地址必须使用 HTTP 或 HTTPS";
    return null;
  } catch {
    return "地址不是有效的 HTTP(S) URL";
  }
}

function checkImage(url, signal) {
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const timer = window.setTimeout(() => finish(false, "加载超时（超过 12 秒）"), LOAD_TIMEOUT);

    function finish(valid, reason = "") {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      image.onload = null;
      image.onerror = null;
      image.src = "";
      resolve({ valid, reason, cancelled: signal.aborted });
    }

    function abort() {
      finish(false, "Scan cancelled");
    }

    signal.addEventListener("abort", abort, { once: true });
    image.referrerPolicy = "no-referrer";
    image.onload = () => finish(image.naturalWidth > 0 && image.naturalHeight > 0, "图片尺寸无效");
    image.onerror = () => finish(false, "无法加载图片或网站图标");
    image.src = url;
  });
}

async function inspectIcon(icon, signal, cache) {
  const url = typeof icon?.url === "string" ? icon.url.trim() : "";
  const urlError = getUrlError(url);
  if (urlError) return { valid: false, reason: urlError, cancelled: false };
  if (!cache.has(url)) cache.set(url, checkImage(url, signal));
  return cache.get(url);
}

function updateDeleteAllLabel() {
  deleteAllButton.textContent = invalidEntries.length
    ? `一键删除无效图标（${invalidEntries.length}）`
    : "一键删除无效图标";
  deleteAllButton.disabled = Boolean(activeScan) || removalSaving || invalidEntries.length === 0;
}

function renderInvalidEntries() {
  list.replaceChildren();
  // Keep the healthy-state message visible while scanning. It only disappears
  // once an invalid result is available to show.
  empty.hidden = invalidEntries.length !== 0;
  invalidEntries.forEach((entry) => {
    const article = document.createElement("article");
    article.className = "icon-validity-item";

    const image = document.createElement("div");
    image.className = "icon-validity-preview";
    image.alt = entry.icon.name || "无效图标";
    image.setAttribute("role", "img");
    image.setAttribute("aria-label", entry.icon.name || "无效图标");
    image.textContent = "!";

    const content = document.createElement("div");
    content.className = "icon-validity-item-content";
    const title = document.createElement("h3");
    title.textContent = entry.icon.name || `第 ${entry.index + 1} 项`;
    const reason = document.createElement("p");
    reason.className = "icon-validity-reason";
    reason.textContent = entry.reason;
    const url = document.createElement("p");
    url.className = "icon-validity-url";
    url.textContent = entry.icon.url || "（空地址）";
    content.append(title, reason, url);

    const action = document.createElement("button");
    action.className = "button button-danger";
    action.type = "button";
    action.disabled = Boolean(activeScan) || removalSaving;
    action.textContent = "删除";
    action.addEventListener("click", () => removeEntry(entry));

    article.append(image, content, action);
    list.append(article);
  });
  updateDeleteAllLabel();
}

async function applyRemoval(entries) {
  const admin = window.embyIconsAdmin;
  if (!admin?.removeIcons) throw new Error("编辑器尚未准备好，请稍后重试");
  const removed = admin.removeIcons(entries.map((entry) => entry.icon));
  if (!removed) return 0;

  const targetSet = new Set(entries.map((entry) => entry.icon));
  invalidEntries = invalidEntries.filter((entry) => !targetSet.has(entry.icon));
  removalSaving = true;
  renderInvalidEntries();
  setScanControls(false);
  note.textContent = `已删除 ${removed} 个图标，正在自动保存…`;
  note.className = "icon-validity-note";
  setSummary("正在自动保存删除结果…", "running");
  try {
    const saved = await admin.save?.();
    if (!saved) {
      note.textContent = "删除已应用到当前编辑器，但自动保存失败，请检查页面提示后重试。";
      note.className = "icon-validity-note is-error";
      throw new Error("自动保存失败，请检查登录状态或云端冲突提示");
    }
    note.textContent = `已删除 ${removed} 个图标，并已自动保存到云端。`;
    note.className = "icon-validity-note is-success";
    return removed;
  } finally {
    removalSaving = false;
    setScanControls(false);
  }
}

async function removeEntry(entry) {
  try {
    const removed = await applyRemoval([entry]);
    if (!removed) setSummary("该图标已被移除，请重新检测。", "error");
  } catch (error) {
    setSummary(error.message, "error");
  }
}

function handleScanError(error) {
  if (activeScan) activeScan.controller.abort();
  activeScan = null;
  setScanControls(false);
  renderInvalidEntries();
  setSummary(error?.message || "检测失败，请重试。", "error");
}

function scheduleResultRender() {
  if (resultRenderFrame) return;
  resultRenderFrame = window.requestAnimationFrame(() => {
    resultRenderFrame = 0;
    renderInvalidEntries();
  });
}

async function runScan() {
  if (activeScan) activeScan.controller.abort();
  const run = { id: ++scanSequence, controller: new AbortController() };
  activeScan = run;
  invalidEntries = [];
  renderInvalidEntries();
  note.textContent = "只会列出无法作为图片或网站图标加载的地址。";
  note.className = "icon-validity-note";
  setScanControls(true);

  const documentData = window.embyIconsAdmin?.getDocument?.();
  const icons = Array.isArray(documentData?.icons) ? [...documentData.icons] : [];
  if (!icons.length) {
    setSummary("当前没有可检测的图标。", "success");
    activeScan = null;
    renderInvalidEntries();
    setScanControls(false);
    updateDeleteAllLabel();
    return;
  }

  let completed = 0;
  let nextIndex = 0;
  const results = [];
  const cache = new Map();
  let lastProgressAt = 0;
  setSummary(`正在检测 0 / ${icons.length}…`, "running");

  async function worker() {
    while (!run.controller.signal.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= icons.length) return;
      const result = await inspectIcon(icons[index], run.controller.signal, cache);
      if (result.cancelled || run.id !== scanSequence) return;
      if (!result.valid) {
        results.push({ icon: icons[index], index, reason: result.reason });
        invalidEntries = results.slice().sort((left, right) => left.index - right.index);
        scheduleResultRender();
      }
      completed += 1;
      const now = Date.now();
      if (completed === icons.length || now - lastProgressAt >= 100) {
        lastProgressAt = now;
        setSummary(`正在检测 ${completed} / ${icons.length}…`, "running");
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, icons.length) }, worker));
  if (run.id !== scanSequence || run.controller.signal.aborted) return;
  results.sort((left, right) => left.index - right.index);
  invalidEntries = results;
  activeScan = null;
  renderInvalidEntries();
  setScanControls(false);
  if (invalidEntries.length) {
    setSummary(`检测完成：${invalidEntries.length} / ${icons.length} 个图标无效。`, "error");
  } else {
    setSummary(`检测完成：${icons.length} 个图标全部有效。`, "success");
  }
}

function openDialog() {
  dialog.showModal();
  if (!window.embyIconsAdmin?.isReady?.()) {
    setSummary("图标库正在加载，请稍候…", "running");
    return;
  }
  runScan().catch((error) => {
    handleScanError(error);
  });
}

function closeDialog() {
  if (activeScan) activeScan.controller.abort();
  scanSequence += 1;
  activeScan = null;
  if (dialog.open) dialog.close();
  setScanControls(false);
}

openButton?.addEventListener("click", openDialog);
closeButton?.addEventListener("click", closeDialog);
rescanButton?.addEventListener("click", () => {
  runScan().catch(handleScanError);
});
deleteAllButton?.addEventListener("click", async () => {
  if (!invalidEntries.length) return;
  if (!window.confirm(`确定删除 ${invalidEntries.length} 个无效图标吗？删除后会立即自动保存到云端。`)) return;
  try {
    const removed = await applyRemoval([...invalidEntries]);
    if (removed) setSummary(`已删除 ${removed} 个无效图标，并已自动保存。`, "success");
  } catch (error) {
    setSummary(error.message, "error");
  }
});
dialog?.addEventListener("click", (event) => {
  if (event.target === dialog) closeDialog();
});
function onDocumentReady() {
  openButton.disabled = false;
  if (dialog.open && !activeScan) runScan().catch(handleScanError);
}

document.addEventListener("emby-icons:document-ready", onDocumentReady);
if (window.embyIconsAdmin?.isReady?.()) openButton.disabled = false;
