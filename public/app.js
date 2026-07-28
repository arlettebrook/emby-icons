const elements = {
  addButton: document.querySelector("#add-icon-button"),
  count: document.querySelector("#icon-count"),
  copyButton: document.querySelector("#copy-button"),
  copyPublicButton: document.querySelector("#copy-public-button"),
  clearSearch: document.querySelector("#clear-search"),
  conflictBanner: document.querySelector("#conflict-banner"),
  conflictClose: document.querySelector("#conflict-close"),
  conflictForce: document.querySelector("#conflict-force"),
  conflictReload: document.querySelector("#conflict-reload"),
  description: document.querySelector("#document-description"),
  dirtyState: document.querySelector("#document-state"),
  emptyAddButton: document.querySelector("#empty-add-button"),
  emptyState: document.querySelector("#empty-state"),
  emptyTitle: document.querySelector("#empty-title"),
  emptyCopy: document.querySelector("#empty-copy"),
  emptyImportButton: document.querySelector("#empty-import-button"),
  exportButton: document.querySelector("#export-button"),
  formatButton: document.querySelector("#format-button"),
  importButton: document.querySelector("#import-button"),
  importCancelButton: document.querySelector("#import-cancel-button"),
  importCloseButton: document.querySelector("#import-close-button"),
  importDialog: document.querySelector("#import-dialog"),
  importEditor: document.querySelector("#import-editor"),
  importError: document.querySelector("#import-error"),
  importFile: document.querySelector("#import-file"),
  importForm: document.querySelector("#import-form"),
  remoteFetchButton: document.querySelector("#remote-fetch-button"),
  remoteUrl: document.querySelector("#remote-url"),
  iconList: document.querySelector("#icon-list"),
  jsonEditor: document.querySelector("#json-editor"),
  jsonMessage: document.querySelector("#json-message"),
  name: document.querySelector("#document-name"),
  reloadButton: document.querySelector("#reload-button"),
  rowTemplate: document.querySelector("#icon-row-template"),
  saveButton: document.querySelector("#save-button"),
  searchInput: document.querySelector("#icon-search"),
  statusDot: document.querySelector("#status-dot"),
  statusText: document.querySelector("#status-text"),
  overviewCount: document.querySelector("#overview-count"),
  overviewSource: document.querySelector("#overview-source"),
  tokenDialog: document.querySelector("#token-dialog"),
  tokenError: document.querySelector("#token-error"),
  tokenForm: document.querySelector("#token-form"),
  tokenInput: document.querySelector("#admin-token"),
  toast: document.querySelector("#toast"),
  toggleToken: document.querySelector("#toggle-token"),
};

let documentData = { name: "Emby Icons", description: "", icons: [] };
let currentEtag = null;
let activeTab = "structured";
let dirty = false;
let saving = false;
let toastTimer;
let filterQuery = "";
let conflictActive = false;
let hasDocument = false;
let forceSaveRequested = false;

const defaultSaveLabel = '<span class="button-icon" aria-hidden="true">↑</span>保存更改';

function showConflict() {
  conflictActive = true;
  elements.conflictBanner.hidden = false;
  if (elements.tokenDialog.open) elements.tokenDialog.close();
  elements.tokenError.textContent = "";
  elements.tokenInput.value = "";
  setConnection("云端版本较新，无法保存到 KV", "error");
  setDirty(true);
}

function clearConflict() {
  conflictActive = false;
  elements.conflictBanner.hidden = true;
  updateSaveAvailability();
}

function dismissConflict() {
  elements.conflictBanner.hidden = true;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2600);
}

function parseImportedIcons(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("JSON 格式无效");
  }

  const icons = Array.isArray(value) ? value : value?.icons;
  if (!Array.isArray(icons)) throw new Error("导入内容必须包含 icons 数组");
  return icons.map((icon, index) => {
    if (!icon || typeof icon !== "object" || Array.isArray(icon)) throw new Error(`icons[${index}] 必须是对象`);
    if (typeof icon.name !== "string" || !icon.name.trim()) throw new Error(`第 ${index + 1} 项缺少名称`);
    if (typeof icon.url !== "string" || !icon.url.trim()) throw new Error(`第 ${index + 1} 项缺少图片地址`);
    try {
      const url = new URL(icon.url);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    } catch {
      throw new Error(`第 ${index + 1} 项图片地址无效`);
    }
    return { ...icon, name: icon.name.trim(), url: icon.url.trim() };
  });
}

function getSerializedDocument() {
  if (!hasDocument) throw new Error("KV 中暂无可导出的数据");
  if (activeTab === "json") {
    if (!syncFromJson()) throw new Error("请先修正 JSON 错误");
  } else {
    syncStructuredFields();
  }
  const validationError = validDocument(documentData);
  if (validationError) throw new Error(validationError);
  return `${JSON.stringify(documentData, null, 2)}\n`;
}

function openImportDialog() {
  elements.importError.textContent = "";
  elements.importFile.value = "";
  elements.importEditor.value = "";
  elements.remoteUrl.value = "";
  elements.importDialog.showModal();
  elements.importFile.focus();
}

async function importDocument(event) {
  event.preventDefault();
  elements.importError.textContent = "";

  try {
    const raw = elements.importFile.files[0]
      ? await elements.importFile.files[0].text()
      : elements.importEditor.value.trim();
    if (!raw) throw new Error("请选择 JSON 文件或粘贴 JSON 内容");
    const importedIcons = parseImportedIcons(raw);
    if (activeTab === "json" && !syncFromJson()) throw new Error("请先修正当前 JSON 错误");
    if (activeTab !== "json") syncStructuredFields();

    const existingNames = new Set(documentData.icons.map((icon) => icon.name.trim().toLocaleLowerCase()));
    const additions = [];
    let skipped = 0;
    for (const icon of importedIcons) {
      const key = icon.name.toLocaleLowerCase();
      if (existingNames.has(key)) {
        skipped += 1;
        continue;
      }
      existingNames.add(key);
      additions.push(icon);
    }

    if (!additions.length) {
      elements.importDialog.close();
      showToast(`没有新增图标，已跳过 ${skipped} 个重复名称`);
      return;
    }

    documentData.icons.push(...additions);
    documentData.name = documentData.name.trim() || "Emby Icons";
    hasDocument = true;
    renderStructured();
    renderJson();
    setDirty(true);
    elements.importDialog.close();
    showToast(`已追加 ${additions.length} 个图标，跳过 ${skipped} 个重复名称`);
    await saveDocument();
  } catch (error) {
    elements.importError.textContent = error.message;
  }
}

async function fetchRemoteJson() {
  const remoteUrl = elements.remoteUrl.value.trim();
  if (!/^https?:\/\//i.test(remoteUrl)) {
    elements.importError.textContent = "请输入 HTTP 或 HTTPS 远程地址";
    return;
  }

  elements.remoteFetchButton.disabled = true;
  elements.remoteFetchButton.textContent = "获取中...";
  elements.importError.textContent = "";
  try {
    const response = await fetch(remoteUrl, { cache: "no-store", headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`远程请求失败 (${response.status})`);
    const icons = parseImportedIcons(await response.text());
    elements.importEditor.value = `${JSON.stringify({ icons }, null, 2)}\n`;
    elements.importFile.value = "";
    showToast(`已获取 ${icons.length} 个远程图标，请点击导入并保存`);
  } catch (error) {
    elements.importError.textContent = `${error.message}。远程站点需要允许浏览器跨域访问。`;
  } finally {
    elements.remoteFetchButton.disabled = false;
    elements.remoteFetchButton.textContent = "获取远程 JSON";
  }
}

function exportDocument() {
  try {
    const serialized = getSerializedDocument();
    const blob = new Blob([serialized], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "emby-icons.json";
    link.click();
    URL.revokeObjectURL(url);
    showToast("JSON 文件已导出");
  } catch (error) {
    showToast(error.message);
  }
}

async function copyDocument() {
  try {
    await navigator.clipboard.writeText(getSerializedDocument());
    showToast("JSON 已复制到剪贴板");
  } catch (error) {
    showToast(error.message || "复制失败，请检查浏览器权限");
  }
}

async function copyPublicConfig() {
  try {
    const publicUrl = new URL("/emby-icons.json", window.location.origin).href;
    await navigator.clipboard.writeText(publicUrl);
    showToast("公开配置 URL 已复制到剪贴板");
  } catch (error) {
    showToast(error.message || "复制失败，请检查浏览器权限");
  }
}

function setConnection(message, state = "online") {
  elements.statusText.textContent = message;
  elements.statusDot.className = `status-dot ${state}`;
  elements.overviewSource.textContent = state === "error" ? "需处理" : state === "warning" ? "待导入" : "KV";
}

function updateSaveAvailability() {
  elements.saveButton.disabled = saving || !dirty || conflictActive;
}

function setDirty(value) {
  dirty = value;
  elements.dirtyState.textContent = value ? "有未保存修改" : "已同步";
  elements.dirtyState.classList.toggle("dirty", value);
  updateSaveAvailability();
}

function setBusy(value) {
  saving = value;
  elements.reloadButton.disabled = value;
  updateSaveAvailability();
  elements.saveButton.innerHTML = value
    ? '<span class="button-icon" aria-hidden="true">…</span>正在保存...'
    : defaultSaveLabel;
}

function validDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "根节点必须是 JSON 对象";
  if (typeof value.name !== "string" || !value.name.trim()) return "name 必须是非空字符串";
  if (typeof value.description !== "string") return "description 必须是字符串";
  if (!Array.isArray(value.icons)) return "icons 必须是数组";

  for (let index = 0; index < value.icons.length; index += 1) {
    const icon = value.icons[index];
    if (!icon || typeof icon !== "object" || Array.isArray(icon)) return `icons[${index}] 必须是对象`;
    if (typeof icon.name !== "string" || !icon.name.trim()) return `第 ${index + 1} 项缺少名称`;
    if (typeof icon.url !== "string" || !icon.url.trim()) return `第 ${index + 1} 项缺少图片地址`;
    try {
      const url = new URL(icon.url);
      if (!["http:", "https:"].includes(url.protocol)) return `第 ${index + 1} 项图片地址无效`;
    } catch {
      return `第 ${index + 1} 项图片地址无效`;
    }
  }
  return null;
}

function syncStructuredFields() {
  documentData.name = elements.name.value;
  documentData.description = elements.description.value;
}

function syncFromJson() {
  try {
    const next = JSON.parse(elements.jsonEditor.value);
    const validationError = validDocument(next);
    if (validationError) throw new Error(validationError);
    documentData = next;
    elements.jsonMessage.textContent = "JSON 有效";
    elements.jsonMessage.classList.remove("invalid");
    elements.jsonMessage.parentElement.classList.remove("invalid");
    return true;
  } catch (error) {
    elements.jsonMessage.textContent = error.message;
    elements.jsonMessage.classList.add("invalid");
    elements.jsonMessage.parentElement.classList.add("invalid");
    return false;
  }
}

function updatePreview(image, url) {
  const preview = image.closest(".icon-preview");
  image.hidden = !url;
  image.src = url || "";
  if (url) preview.href = url;
  else preview.removeAttribute("href");
  preview.tabIndex = url ? 0 : -1;
  preview.classList.toggle("is-empty", !url);
  preview.classList.remove("is-broken", "has-image");
  image.onerror = () => {
    image.hidden = true;
    preview.classList.add("is-broken");
  };
  image.onload = () => {
    image.hidden = false;
    preview.classList.add("has-image");
  };
}

function renderIconList() {
  elements.iconList.replaceChildren();
  const normalizedQuery = filterQuery.trim().toLocaleLowerCase();
  const visibleIcons = documentData.icons
    .map((icon, index) => ({ icon, index }))
    .filter(({ icon }) => !normalizedQuery || `${icon.name} ${icon.url}`.toLocaleLowerCase().includes(normalizedQuery));

  elements.count.textContent = normalizedQuery
    ? `${visibleIcons.length} / ${documentData.icons.length} 项`
    : `${documentData.icons.length} 项`;
  elements.overviewCount.textContent = String(documentData.icons.length);
  elements.emptyState.hidden = visibleIcons.length > 0;
  elements.emptyTitle.textContent = normalizedQuery ? "没有匹配结果" : "暂无图标";
  elements.emptyCopy.textContent = normalizedQuery ? "换一个关键词，或清除搜索条件。" : "添加你的第一个图标开始吧。";
  elements.emptyAddButton.hidden = Boolean(normalizedQuery);

  visibleIcons.forEach(({ icon, index }) => {
    const row = elements.rowTemplate.content.firstElementChild.cloneNode(true);
    const nameInput = row.querySelector('[data-field="name"]');
    const urlInput = row.querySelector('[data-field="url"]');
    const image = row.querySelector("img");
    const preview = row.querySelector(".icon-preview");

    row.dataset.index = String(index);
    row.querySelector(".row-index").textContent = String(index + 1).padStart(2, "0");
    nameInput.value = icon.name;
    urlInput.value = icon.url;
    image.alt = icon.name ? `${icon.name} 预览` : "图标预览";
    preview.setAttribute("aria-label", `在新窗口打开 ${icon.name || "图标"} 预览`);
    updatePreview(image, icon.url);
    row.querySelector(".move-up").disabled = index === 0;
    row.querySelector(".move-down").disabled = index === documentData.icons.length - 1;
    elements.iconList.append(row);
  });
}

function renderStructured() {
  elements.name.value = documentData.name;
  elements.description.value = documentData.description;
  renderIconList();
}

function renderJson() {
  elements.jsonEditor.value = `${JSON.stringify(documentData, null, 2)}\n`;
  elements.jsonMessage.textContent = "JSON 有效";
  elements.jsonMessage.classList.remove("invalid");
  elements.jsonMessage.parentElement.classList.remove("invalid");
}

function addIcon() {
  if (activeTab === "json" && !syncFromJson()) return;
  syncStructuredFields();
  documentData.icons.push({ name: "", url: "" });
  filterQuery = "";
  elements.searchInput.value = "";
  renderStructured();
  setDirty(true);
  requestAnimationFrame(() => [...elements.iconList.children].find((row) => row.dataset.index === String(documentData.icons.length - 1))?.querySelector('[data-field="name"]')?.focus());
}

function switchTab(nextTab) {
  if (nextTab === activeTab) return;

  if (activeTab === "json") {
    if (!syncFromJson()) {
      showToast("请先修正 JSON 错误");
      return;
    }
    renderStructured();
  } else {
    syncStructuredFields();
    renderJson();
  }

  activeTab = nextTab;
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.tab === nextTab));
  document.querySelectorAll(".panel").forEach((panel) => panel.classList.remove("is-active"));
  document.querySelector(`#${nextTab}-panel`).classList.add("is-active");
}

async function loadDocument({ confirmDiscard = false } = {}) {
  if (confirmDiscard && dirty && !window.confirm("放弃尚未保存的修改并重新加载吗？")) return;

  setConnection("正在连接 Cloudflare...", "");
  elements.reloadButton.disabled = true;
  try {
    const response = await fetch("/api/icons", { cache: "no-store" });
    if (response.status === 404) {
      documentData = { name: "Emby Icons", description: "", icons: [] };
      hasDocument = false;
      currentEtag = null;
      clearConflict();
      renderStructured();
      renderJson();
      setDirty(false);
      setConnection("KV 中暂无数据，请导入 JSON", "warning");
      showToast("KV 中暂无数据，请导入 JSON");
      return;
    }
    if (!response.ok) throw new Error(`加载失败 (${response.status})`);
    const next = await response.json();
    const validationError = validDocument(next);
    if (validationError) throw new Error(validationError);

    documentData = next;
    hasDocument = true;
    currentEtag = response.headers.get("ETag");
    clearConflict();
    renderStructured();
    renderJson();
    setDirty(false);
    setConnection("已连接 Cloudflare KV");
  } catch (error) {
    setConnection(error.message, "error");
    showToast(error.message);
  } finally {
    elements.reloadButton.disabled = false;
  }
}

async function saveDocument(token = sessionStorage.getItem("emby-icons-admin-token"), force = false) {
  if (saving) return;
  if (!dirty) {
    showToast("当前没有待保存的修改");
    return;
  }
  if (conflictActive && !force) {
    showToast("请先重新加载云端版本，再保存修改");
    return;
  }
  if (activeTab === "json") {
    if (!syncFromJson()) {
      showToast("JSON 校验未通过");
      return;
    }
  } else {
    syncStructuredFields();
  }

  const validationError = validDocument(documentData);
  if (validationError) {
    showToast(validationError);
    return;
  }

  if (!token) {
    forceSaveRequested = force;
    elements.tokenError.textContent = "";
    elements.tokenInput.value = "";
    elements.tokenDialog.showModal();
    elements.tokenInput.focus();
    return;
  }

  setBusy(true);
  try {
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    // Cloudflare KV is eventually consistent across edge locations. A client ETag
    // can legitimately differ from the node handling this write, so normal saves
    // use last-write-wins. Strict If-Match remains available to API clients.
    if (force) headers["X-Force-Overwrite"] = "true";

    const response = await fetch("/api/icons", {
      method: "PUT",
      headers,
      body: JSON.stringify(documentData),
    });
    const result = await response.json().catch(() => ({}));

    if (response.status === 401) {
      sessionStorage.removeItem("emby-icons-admin-token");
      elements.tokenError.textContent = result.error || "管理员令牌无效";
      elements.tokenInput.value = "";
      if (!elements.tokenDialog.open) elements.tokenDialog.showModal();
      elements.tokenInput.focus();
      return;
    }
    if (response.status === 412) {
      showConflict();
      showToast("云端内容已更新，请重新加载后再保存");
      return;
    }
    if (!response.ok) throw new Error(result.error || `保存失败 (${response.status})`);

    sessionStorage.setItem("emby-icons-admin-token", token);
    hasDocument = true;
    currentEtag = response.headers.get("ETag");
    renderJson();
    setDirty(false);
    clearConflict();
    setConnection("已连接 Cloudflare KV");
    if (elements.tokenDialog.open) elements.tokenDialog.close();
    showToast(`已保存 ${result.count} 个图标`);
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(false);
  }
}

elements.name.addEventListener("input", () => {
  documentData.name = elements.name.value;
  setDirty(true);
});

elements.description.addEventListener("input", () => {
  documentData.description = elements.description.value;
  setDirty(true);
});

elements.iconList.addEventListener("input", (event) => {
  const input = event.target.closest("input[data-field]");
  if (!input) return;
  const row = input.closest(".icon-row");
  const index = Number(row.dataset.index);
  documentData.icons[index][input.dataset.field] = input.value;
  if (input.dataset.field === "url") updatePreview(row.querySelector("img"), input.value);
  if (input.dataset.field === "name") row.querySelector("img").alt = `${input.value || "图标"} 预览`;
  setDirty(true);
});

elements.iconList.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const index = Number(button.closest(".icon-row").dataset.index);

  if (button.classList.contains("delete-icon")) {
    const label = documentData.icons[index].name || `第 ${index + 1} 项`;
    if (!window.confirm(`删除“${label}”吗？`)) return;
    documentData.icons.splice(index, 1);
  } else if (button.classList.contains("move-up") && index > 0) {
    [documentData.icons[index - 1], documentData.icons[index]] = [documentData.icons[index], documentData.icons[index - 1]];
  } else if (button.classList.contains("move-down") && index < documentData.icons.length - 1) {
    [documentData.icons[index + 1], documentData.icons[index]] = [documentData.icons[index], documentData.icons[index + 1]];
  } else {
    return;
  }

  renderIconList();
  setDirty(true);
});

elements.jsonEditor.addEventListener("input", () => {
  setDirty(true);
  syncFromJson();
});

elements.formatButton.addEventListener("click", () => {
  if (!syncFromJson()) return;
  renderJson();
});

elements.searchInput.addEventListener("input", () => {
  filterQuery = elements.searchInput.value;
  renderIconList();
});

elements.clearSearch.addEventListener("click", () => {
  filterQuery = "";
  elements.searchInput.value = "";
  renderIconList();
  elements.searchInput.focus();
});

elements.addButton.addEventListener("click", addIcon);
elements.emptyAddButton.addEventListener("click", addIcon);
elements.importButton.addEventListener("click", openImportDialog);
elements.emptyImportButton.addEventListener("click", openImportDialog);
elements.importCancelButton.addEventListener("click", () => elements.importDialog.close());
elements.importCloseButton.addEventListener("click", () => elements.importDialog.close());
elements.exportButton.addEventListener("click", exportDocument);
elements.copyButton.addEventListener("click", copyDocument);
elements.copyPublicButton.addEventListener("click", copyPublicConfig);
elements.remoteFetchButton.addEventListener("click", fetchRemoteJson);
elements.reloadButton.addEventListener("click", () => loadDocument({ confirmDiscard: true }));
elements.conflictReload.addEventListener("click", () => loadDocument({ confirmDiscard: true }));
elements.conflictForce.addEventListener("click", () => {
  if (!window.confirm("确定使用当前编辑内容覆盖云端版本吗？此操作会覆盖其他会话的修改。")) return;
  saveDocument(sessionStorage.getItem("emby-icons-admin-token"), true);
});
elements.conflictClose.addEventListener("click", dismissConflict);
elements.saveButton.addEventListener("click", () => saveDocument());
document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => switchTab(tab.dataset.tab)));

elements.toggleToken.addEventListener("click", () => {
  const visible = elements.tokenInput.type === "text";
  elements.tokenInput.type = visible ? "password" : "text";
  elements.toggleToken.textContent = visible ? "显示" : "隐藏";
  elements.toggleToken.setAttribute("aria-label", visible ? "显示令牌" : "隐藏令牌");
  elements.toggleToken.setAttribute("title", visible ? "显示令牌" : "隐藏令牌");
});

elements.tokenForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const token = elements.tokenInput.value.trim();
  if (token) {
    const force = forceSaveRequested;
    forceSaveRequested = false;
    saveDocument(token, force);
  }
});

elements.tokenDialog.addEventListener("close", () => {
  if (!saving) forceSaveRequested = false;
});

elements.importForm.addEventListener("submit", (event) => {
  if (event.submitter?.value === "cancel") return;
  importDocument(event);
});

window.addEventListener("beforeunload", (event) => {
  if (!dirty) return;
  event.preventDefault();
});

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveDocument();
  }
});

loadDocument();
