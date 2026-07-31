const elements = {
  addButton: document.querySelector("#add-icon-button"),
  count: document.querySelector("#icon-count"),
  copyButton: document.querySelector("#copy-button"),
  copyPublicButton: document.querySelector("#copy-public-button"),
  clearSearch: document.querySelector("#clear-search"),
  deleteSearchResults: document.querySelector("#delete-search-results"),
  searchDeleteDialog: document.querySelector("#search-delete-dialog"),
  searchDeleteClose: document.querySelector("#search-delete-close"),
  searchDeleteCancel: document.querySelector("#search-delete-cancel"),
  searchDeleteConfirm: document.querySelector("#search-delete-confirm"),
  searchDeleteLead: document.querySelector("#search-delete-lead"),
  searchDeleteTargets: document.querySelector("#search-delete-targets"),
  searchDeleteError: document.querySelector("#search-delete-error"),
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
  iconSort: document.querySelector("#icon-sort"),
  loadMoreButton: document.querySelector("#load-more-button"),
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
  tokenCancelButton: document.querySelector("#token-cancel-button"),
  tokenCloseButton: document.querySelector("#token-close-button"),
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
let documentReady = false;
let forceSaveRequested = false;
let sortMode = "manual";
let renderLimit = 24;
let searchIndex = [];
let renderFrame = 0;
let pendingSearchDeleteIcons = [];

const defaultSaveLabel = '<span class="button-icon" aria-hidden="true">↑</span>保存更改';

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const helper = document.createElement("textarea");
  helper.value = value;
  helper.setAttribute("readonly", "");
  helper.style.position = "fixed";
  helper.style.opacity = "0";
  document.body.append(helper);
  helper.select();
  const copied = document.execCommand("copy");
  helper.remove();
  if (!copied) throw new Error("复制失败，请手动选择地址复制");
}

function rebuildSearchIndex() {
  searchIndex = documentData.icons.map((icon) => `${icon.name} ${icon.url}`.toLocaleLowerCase());
}

function scheduleIconListRender() {
  if (renderFrame) cancelAnimationFrame(renderFrame);
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    renderIconList();
  });
}

function sortDocumentIcons(mode) {
  if (mode === "manual") return false;
  const direction = mode === "name-desc" ? -1 : 1;
  const before = documentData.icons.map((icon) => icon);
  documentData.icons.sort((left, right) => {
    const byName = left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" });
    return direction * byName;
  });
  return before.some((icon, index) => icon !== documentData.icons[index]);
}

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

function updateSearchClearButton() {
  elements.clearSearch.hidden = elements.searchInput.value.length === 0;
}

function getSearchMatches() {
  if (searchIndex.length !== documentData.icons.length) rebuildSearchIndex();
  const normalizedQuery = filterQuery.trim().toLocaleLowerCase();
  return documentData.icons
    .map((icon, index) => ({ icon, index }))
    .filter(({ index }) => !normalizedQuery || searchIndex[index].includes(normalizedQuery));
}

function updateSearchDeleteButton(matchCount = getSearchMatches().length) {
  const hasSearch = filterQuery.trim().length > 0;
  elements.deleteSearchResults.hidden = !hasSearch || matchCount === 0;
  elements.deleteSearchResults.textContent = `删除搜索结果（${matchCount}）`;
}

function renderSearchDeleteTargets(matches) {
  elements.searchDeleteTargets.replaceChildren();
  const fragment = document.createDocumentFragment();
  matches.forEach(({ icon, index }) => {
    const target = document.createElement("article");
    target.className = "search-delete-target";
    const name = document.createElement("strong");
    name.textContent = icon.name || `第 ${index + 1} 项`;
    const url = document.createElement("span");
    url.textContent = icon.url || "（空地址）";
    target.append(name, url);
    fragment.append(target);
  });
  elements.searchDeleteTargets.append(fragment);
}

function openSearchDeleteDialog() {
  try {
    syncCurrentEditorState();
  } catch (error) {
    showToast(error.message);
    return;
  }

  const matches = getSearchMatches();
  if (!matches.length) {
    updateSearchDeleteButton(0);
    return;
  }

  pendingSearchDeleteIcons = matches.map(({ icon }) => icon);
  elements.searchDeleteLead.textContent = `将删除当前搜索匹配的 ${matches.length} 个图标，删除后需要点击“保存更改”同步到云端。`;
  elements.searchDeleteError.textContent = "";
  elements.searchDeleteConfirm.disabled = false;
  renderSearchDeleteTargets(matches);
  elements.searchDeleteDialog.showModal();
}

function closeSearchDeleteDialog() {
  pendingSearchDeleteIcons = [];
  if (elements.searchDeleteDialog.open) elements.searchDeleteDialog.close();
}

function confirmSearchDelete() {
  const targets = new Set(pendingSearchDeleteIcons);
  if (!targets.size) return;
  elements.searchDeleteConfirm.disabled = true;
  try {
    const before = documentData.icons.length;
    documentData.icons = documentData.icons.filter((icon) => !targets.has(icon));
    const removed = before - documentData.icons.length;
    if (!removed) throw new Error("搜索结果已发生变化，请重新搜索后再试");
    rebuildSearchIndex();
    renderStructured();
    renderJson();
    setDirty(true);
    closeSearchDeleteDialog();
    showToast(`已删除 ${removed} 个搜索结果，请点击“保存更改”同步到云端`);
  } catch (error) {
    elements.searchDeleteError.textContent = error.message;
    elements.searchDeleteConfirm.disabled = false;
  }
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
    rebuildSearchIndex();
    if (sortMode !== "manual") {
      sortDocumentIcons(sortMode);
      rebuildSearchIndex();
    }
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

  const token = sessionStorage.getItem("emby-icons-admin-token") || "";

  elements.remoteFetchButton.disabled = true;
  elements.remoteFetchButton.textContent = "获取中...";
  elements.importError.textContent = "";
  try {
    const response = await fetch("/api/import", {
      method: "POST",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      body: JSON.stringify({ url: remoteUrl }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) {
      sessionStorage.removeItem("emby-icons-admin-token");
      throw new Error(body.error || "管理员令牌无效");
    }
    if (!response.ok) throw new Error(body.error || `远程请求失败 (${response.status})`);
    const icons = parseImportedIcons(JSON.stringify(body.value));
    if (token) sessionStorage.setItem("emby-icons-admin-token", token);
    elements.importEditor.value = `${JSON.stringify({ icons }, null, 2)}\n`;
    elements.importFile.value = "";
    showToast(`已获取 ${icons.length} 个远程图标，请点击导入并保存`);
  } catch (error) {
    elements.importError.textContent = error.message;
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
    await copyText(getSerializedDocument());
    showToast("JSON 已复制到剪贴板");
  } catch (error) {
    showToast(error.message || "复制失败，请检查浏览器权限");
  }
}

async function copyPublicConfig() {
  try {
    const publicUrl = new URL("/emby-icons.json", window.location.origin).href;
    await copyText(publicUrl);
    showToast("图标库地址已复制到剪贴板");
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
  document.body.classList.toggle("has-unsaved-changes", value);
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
    rebuildSearchIndex();
    if (activeTab === "json") {
      sortMode = "manual";
      elements.iconSort.value = sortMode;
    }
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
  const normalizedUrl = url.trim();
  image.hidden = !normalizedUrl;
  image.src = normalizedUrl || "";
  if (normalizedUrl) preview.href = normalizedUrl;
  else preview.removeAttribute("href");
  preview.tabIndex = normalizedUrl ? 0 : -1;
  preview.classList.toggle("is-empty", !normalizedUrl);
  preview.classList.remove("is-broken", "has-image");
  if (!normalizedUrl) {
    image.removeAttribute("src");
    return;
  }
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
  const visibleIcons = getSearchMatches();

  const displayedIcons = visibleIcons.slice(0, renderLimit);

  elements.count.textContent = normalizedQuery || displayedIcons.length < visibleIcons.length
    ? `${displayedIcons.length} / ${visibleIcons.length} 项`
    : `${visibleIcons.length} 项`;
  elements.overviewCount.textContent = String(documentData.icons.length);
  elements.emptyState.hidden = visibleIcons.length > 0;
  elements.emptyTitle.textContent = normalizedQuery ? "没有匹配结果" : "暂无图标";
  elements.emptyCopy.textContent = normalizedQuery ? "换一个关键词，或清除搜索条件。" : "添加你的第一个图标开始吧。";
  elements.emptyAddButton.hidden = Boolean(normalizedQuery);
  updateSearchDeleteButton(visibleIcons.length);

  const fragment = document.createDocumentFragment();
  displayedIcons.forEach(({ icon, index }) => {
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
    row.querySelector(".move-up").disabled = sortMode !== "manual" || index === 0;
    row.querySelector(".move-down").disabled = sortMode !== "manual" || index === documentData.icons.length - 1;
    fragment.append(row);
  });
  elements.iconList.append(fragment);
  elements.loadMoreButton.hidden = displayedIcons.length >= visibleIcons.length;
  elements.loadMoreButton.textContent = `加载更多图标（剩余 ${visibleIcons.length - displayedIcons.length} 个）`;
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
  const previousScroll = window.scrollY;
  documentData.icons.unshift({ name: "", url: "" });
  rebuildSearchIndex();
  sortMode = "manual";
  elements.iconSort.value = sortMode;
  filterQuery = "";
  elements.searchInput.value = "";
  renderLimit = 24;
  renderStructured();
  setDirty(true);
  requestAnimationFrame(() => {
    window.scrollTo({ top: previousScroll, behavior: "auto" });
    elements.iconList.querySelector('[data-index="0"] [data-field="name"]')?.focus({ preventScroll: true });
  });
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
      rebuildSearchIndex();
      sortMode = "manual";
      elements.iconSort.value = sortMode;
      hasDocument = false;
      currentEtag = null;
      clearConflict();
      renderStructured();
      renderJson();
      setDirty(false);
      documentReady = true;
      document.dispatchEvent(new CustomEvent("emby-icons:document-ready"));
      setConnection("KV 中暂无数据，请导入 JSON", "warning");
      showToast("KV 中暂无数据，请导入 JSON");
      return;
    }
    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw new Error(errorBody.error || `加载失败 (${response.status})`);
    }
    const next = await response.json();
    const validationError = validDocument(next);
    if (validationError) throw new Error(validationError);

    documentData = next;
    rebuildSearchIndex();
    sortMode = "manual";
    elements.iconSort.value = sortMode;
    hasDocument = true;
    currentEtag = response.headers.get("ETag");
    clearConflict();
    renderStructured();
    renderJson();
    setDirty(false);
    documentReady = true;
    document.dispatchEvent(new CustomEvent("emby-icons:document-ready"));
    setConnection("已连接 Cloudflare KV");
  } catch (error) {
    setConnection(error.message, "error");
    showToast(error.message);
  } finally {
    elements.reloadButton.disabled = false;
  }
}

async function saveDocument(token = sessionStorage.getItem("emby-icons-admin-token"), force = false, silent = false) {
  const notify = (message) => {
    if (!silent) showToast(message);
  };
  if (saving) return false;
  if (!dirty) {
    notify("当前没有待保存的修改");
    return false;
  }
  if (conflictActive && !force) {
    notify("请先重新加载云端版本，再保存修改");
    return false;
  }
  if (activeTab === "json") {
    if (!syncFromJson()) {
      notify("JSON 校验未通过");
      return false;
    }
  } else {
    syncStructuredFields();
  }

  const validationError = validDocument(documentData);
  if (validationError) {
    notify(validationError);
    return false;
  }

  setBusy(true);
  try {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    // Cloudflare KV is eventually consistent across edge locations. A client ETag
    // can legitimately differ from the node handling this write, so normal saves
    // use last-write-wins. Strict If-Match remains available to API clients.
    if (force) headers["X-Force-Overwrite"] = "true";

    const response = await fetch("/api/icons", {
      method: "PUT",
      credentials: "same-origin",
      headers,
      body: JSON.stringify(documentData),
    });
    const result = await response.json().catch(() => ({}));

    if (response.status === 401) {
      sessionStorage.removeItem("emby-icons-admin-token");
      window.location.assign("/admin.html?login=1");
      return false;
    }
    if (response.status === 412) {
      showConflict();
      notify("云端内容已更新，请重新加载后再保存");
      return false;
    }
    if (!response.ok) throw new Error(result.error || `保存失败 (${response.status})`);

    if (token) sessionStorage.setItem("emby-icons-admin-token", token);
    hasDocument = true;
    currentEtag = response.headers.get("ETag");
    renderJson();
    setDirty(false);
    clearConflict();
    setConnection("已连接 Cloudflare KV");
    if (elements.tokenDialog.open) elements.tokenDialog.close();
    notify(`已保存 ${result.count} 个图标`);
    return true;
  } catch (error) {
    notify(error.message);
    return false;
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
  searchIndex[index] = `${documentData.icons[index].name} ${documentData.icons[index].url}`.toLocaleLowerCase();
  if (input.dataset.field === "url") updatePreview(row.querySelector("img"), input.value);
  if (input.dataset.field === "name") row.querySelector("img").alt = `${input.value || "图标"} 预览`;
  setDirty(true);
});

elements.iconList.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const index = Number(button.closest(".icon-row").dataset.index);

  if (button.classList.contains("copy-url")) {
    const url = documentData.icons[index]?.url?.trim();
    if (!url) {
      showToast("请先填写图片地址");
      return;
    }
    copyText(url)
      .then(() => showToast("图片地址已复制到剪贴板"))
      .catch((error) => showToast(error.message || "复制失败，请手动选择地址复制"));
    return;
  }

  if (button.classList.contains("delete-icon")) {
    const label = documentData.icons[index].name || `第 ${index + 1} 项`;
    if (!window.confirm(`删除“${label}”吗？`)) return;
    documentData.icons.splice(index, 1);
    rebuildSearchIndex();
  } else if (button.classList.contains("move-up") && index > 0) {
    if (sortMode !== "manual") return;
    [documentData.icons[index - 1], documentData.icons[index]] = [documentData.icons[index], documentData.icons[index - 1]];
    rebuildSearchIndex();
  } else if (button.classList.contains("move-down") && index < documentData.icons.length - 1) {
    if (sortMode !== "manual") return;
    [documentData.icons[index + 1], documentData.icons[index]] = [documentData.icons[index], documentData.icons[index + 1]];
    rebuildSearchIndex();
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
  renderLimit = 24;
  updateSearchClearButton();
  scheduleIconListRender();
});

elements.deleteSearchResults.addEventListener("click", openSearchDeleteDialog);
elements.searchDeleteClose.addEventListener("click", closeSearchDeleteDialog);
elements.searchDeleteCancel.addEventListener("click", closeSearchDeleteDialog);
elements.searchDeleteConfirm.addEventListener("click", confirmSearchDelete);
elements.searchDeleteDialog.addEventListener("click", (event) => {
  if (event.target === elements.searchDeleteDialog) closeSearchDeleteDialog();
});

elements.clearSearch.addEventListener("click", () => {
  filterQuery = "";
  elements.searchInput.value = "";
  renderLimit = 24;
  updateSearchClearButton();
  renderIconList();
  elements.searchInput.focus();
});

elements.iconSort.addEventListener("change", () => {
  sortMode = elements.iconSort.value;
  renderLimit = 24;
  const changed = sortDocumentIcons(sortMode);
  rebuildSearchIndex();
  renderIconList();
  if (changed) {
    renderJson();
    setDirty(true);
    showToast("排序已应用到 JSON，请保存更改");
  }
});

elements.loadMoreButton.addEventListener("click", () => {
  renderLimit += 24;
  renderIconList();
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
  const visible = elements.tokenInput.classList.toggle("is-visible");
  elements.toggleToken.textContent = visible ? "隐藏" : "显示";
  elements.toggleToken.setAttribute("aria-label", visible ? "隐藏令牌" : "显示令牌");
  elements.toggleToken.setAttribute("title", visible ? "隐藏令牌" : "显示令牌");
});

elements.tokenCancelButton.addEventListener("click", () => elements.tokenDialog.close("cancel"));
elements.tokenCloseButton.addEventListener("click", () => elements.tokenDialog.close("cancel"));

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

function syncCurrentEditorState() {
  if (activeTab === "json") {
    if (!syncFromJson()) throw new Error("请先修正 JSON 错误，再进行图标检测或删除");
  } else {
    syncStructuredFields();
  }
  return documentData;
}

window.embyIconsAdmin = {
  isReady: () => documentReady,
  getDocument: () => syncCurrentEditorState(),
  save: async () => {
    while (saving) await new Promise((resolve) => window.setTimeout(resolve, 50));
    return saveDocument(undefined, false, true);
  },
  removeIcons: (icons) => {
    if (!Array.isArray(icons) || !icons.length) return 0;
    syncCurrentEditorState();
    const targets = new Set(icons);
    const before = documentData.icons.length;
    documentData.icons = documentData.icons.filter((icon) => !targets.has(icon));
    const removed = before - documentData.icons.length;
    if (!removed) return 0;
    rebuildSearchIndex();
    renderStructured();
    renderJson();
    setDirty(true);
    return removed;
  },
};

updateSearchClearButton();
loadDocument();
