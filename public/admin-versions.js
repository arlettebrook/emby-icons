const openButton = document.querySelector("#versions-open-button");
const dialog = document.querySelector("#versions-dialog");
const closeButton = document.querySelector("#versions-close");
const refreshButton = document.querySelector("#versions-refresh");
const moreButton = document.querySelector("#versions-more");
const list = document.querySelector("#versions-list");
const listStatus = document.querySelector("#versions-status");
const placeholder = document.querySelector("#versions-placeholder");
const detailContent = document.querySelector("#versions-detail-content");
const detailTitle = document.querySelector("#version-detail-title");
const detailMeta = document.querySelector("#version-detail-meta");
const detailError = document.querySelector("#versions-error");
const documentMeta = document.querySelector("#version-document-meta");
const previewGrid = document.querySelector("#version-preview-grid");
const previewNote = document.querySelector("#version-preview-note");
const jsonOutput = document.querySelector("#version-json");
const restoreButton = document.querySelector("#version-restore-button");

const PAGE_SIZE = 30;
const PREVIEW_LIMIT = 60;
const dateFormatter = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" });

let nextCursor = null;
let listLoading = false;
let selectedVersionId = null;
let selectedVersion = null;
let selectedEtag = null;
let detailRequest = 0;

function adminHeaders() {
  const token = sessionStorage.getItem("emby-icons-admin-token") || "";
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function setListStatus(message, error = false) {
  if (!listStatus) return;
  listStatus.textContent = message;
  listStatus.style.color = error ? "var(--danger)" : "";
}

function setDetailError(message = "") {
  if (!detailError) return;
  detailError.textContent = message;
  detailError.hidden = !message;
}

function formatTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "时间未知";
  return dateFormatter.format(new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp));
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "大小未知";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function reasonLabel(reason) {
  const value = String(reason || "update");
  if (value === "admin-document-update") return "管理员保存";
  if (value.startsWith("approve-submission:")) return `审核通过 #${value.slice("approve-submission:".length)}`;
  if (value.startsWith("before-restore:")) return `回滚前自动备份（目标 #${value.slice("before-restore:".length)}）`;
  return value;
}

function makeVersionRow(version) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "version-row";
  button.dataset.versionId = String(version.id);
  button.setAttribute("aria-label", `查看版本 #${version.id}`);

  const heading = document.createElement("strong");
  heading.textContent = `版本 #${version.id}`;
  const time = document.createElement("span");
  time.textContent = formatTimestamp(version.createdAt);
  const meta = document.createElement("span");
  meta.textContent = `${reasonLabel(version.reason)} · ${version.actorId || "system"} · ${formatBytes(version.sizeBytes)}`;
  meta.title = meta.textContent;

  button.append(heading, time, meta);
  button.addEventListener("click", () => selectVersion(version.id));
  return button;
}

function markSelected(id) {
  list?.querySelectorAll(".version-row").forEach((row) => {
    row.classList.toggle("is-active", Number(row.dataset.versionId) === Number(id));
  });
}

function resetSelection() {
  selectedVersionId = null;
  selectedVersion = null;
  selectedEtag = null;
  if (placeholder) placeholder.hidden = false;
  if (detailContent) detailContent.hidden = true;
  if (restoreButton) restoreButton.disabled = true;
  setDetailError();
}

async function loadVersions({ append = false } = {}) {
  if (listLoading || !list) return;
  listLoading = true;
  if (refreshButton) refreshButton.disabled = true;
  if (moreButton) moreButton.disabled = true;
  if (!append) {
    nextCursor = null;
    resetSelection();
    list.replaceChildren();
  }
  setListStatus(append ? "正在加载更早版本…" : "正在加载版本历史…");

  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (append && nextCursor) params.set("cursor", nextCursor);

  try {
    const response = await fetch(`/api/admin/versions?${params}`, { headers: adminHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `加载版本历史失败（${response.status}）`);
    const versions = Array.isArray(body.versions) ? body.versions : [];
    const rows = versions.map(makeVersionRow);
    if (append) list.append(...rows);
    else list.replaceChildren(...rows);
    nextCursor = body.nextCursor || null;
    if (moreButton) moreButton.hidden = !nextCursor;
    setListStatus(rows.length || append ? `已加载 ${list.querySelectorAll(".version-row").length} 个版本。` : "暂无历史版本。每次保存或审核通过后会自动生成快照。");
  } catch (error) {
    setListStatus(error.message, true);
  } finally {
    listLoading = false;
    if (refreshButton) refreshButton.disabled = false;
    if (moreButton) moreButton.disabled = false;
  }
}

function makePreviewCard(icon) {
  const card = document.createElement("div");
  card.className = "version-preview-card";
  const image = document.createElement("img");
  image.src = String(icon?.url || "");
  image.alt = String(icon?.name || "图标");
  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  const fallback = document.createElement("span");
  fallback.textContent = "图片不可用";
  fallback.hidden = true;
  image.addEventListener("error", () => {
    image.hidden = true;
    fallback.hidden = false;
  }, { once: true });
  const name = document.createElement("span");
  name.textContent = String(icon?.name || "未命名");
  name.title = name.textContent;
  card.append(image, fallback, name);
  return card;
}

function renderDetail(version) {
  const icons = Array.isArray(version?.document?.icons) ? version.document.icons : [];
  if (detailTitle) detailTitle.textContent = `版本 #${version.id}`;
  if (detailMeta) {
    detailMeta.textContent = `${formatTimestamp(version.createdAt)} · ${reasonLabel(version.reason)} · ${version.actorId || "system"} · ${formatBytes(version.sizeBytes)}`;
  }
  if (documentMeta) {
    const name = String(version?.document?.name || "未命名文档");
    const description = String(version?.document?.description || "").trim();
    documentMeta.textContent = `${name}${description ? ` · ${description}` : ""} · ${icons.length} 个图标`;
  }
  if (previewGrid) {
    previewGrid.replaceChildren(...icons.slice(0, PREVIEW_LIMIT).map(makePreviewCard));
  }
  if (previewNote) {
    previewNote.textContent = icons.length > PREVIEW_LIMIT
      ? `图标较多，仅显示前 ${PREVIEW_LIMIT} 个，共 ${icons.length} 个。`
      : icons.length
        ? `共 ${icons.length} 个图标。`
        : "此快照没有图标。";
  }
  if (jsonOutput) jsonOutput.textContent = JSON.stringify(version.document, null, 2);
}

async function selectVersion(id) {
  if (!dialog || !detailContent || !placeholder) return;
  selectedVersionId = Number(id);
  selectedVersion = null;
  selectedEtag = null;
  markSelected(id);
  placeholder.hidden = true;
  detailContent.hidden = false;
  if (detailTitle) detailTitle.textContent = `版本 #${id}`;
  if (detailMeta) detailMeta.textContent = "正在读取快照…";
  if (documentMeta) documentMeta.textContent = "";
  if (previewGrid) previewGrid.replaceChildren();
  if (previewNote) previewNote.textContent = "";
  if (jsonOutput) jsonOutput.textContent = "";
  if (restoreButton) restoreButton.disabled = true;
  setDetailError();

  const requestId = ++detailRequest;
  try {
    const response = await fetch(`/api/admin/versions/${encodeURIComponent(id)}`, { headers: adminHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `读取版本失败（${response.status}）`);
    if (requestId !== detailRequest || selectedVersionId !== Number(id)) return;
    selectedVersion = body.version;
    selectedEtag = typeof body.currentEtag === "string" ? body.currentEtag : "";
    renderDetail(body.version);
    if (restoreButton) restoreButton.disabled = false;
  } catch (error) {
    if (requestId !== detailRequest) return;
    if (detailMeta) detailMeta.textContent = "版本读取失败";
    setDetailError(error.message);
  }
}

async function restoreSelectedVersion() {
  if (!selectedVersion || !restoreButton) return;
  const id = Number(selectedVersion.id);
  const confirmed = window.confirm(
    `确定要回滚到版本 #${id} 吗？\n\n线上文档会立即被替换，服务器会先自动保存当前线上版本。管理面板中尚未保存的编辑内容不会保留。`,
  );
  if (!confirmed) return;

  restoreButton.disabled = true;
  setDetailError("正在回滚，请稍候…");
  try {
    const response = await fetch(`/api/admin/versions/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ action: "restore", expectedEtag: selectedEtag || "" }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (body.code === "ETAG_MISMATCH") {
        if (typeof body.etag === "string") selectedEtag = body.etag;
        const refreshed = await fetch(`/api/admin/versions/${encodeURIComponent(id)}`, { headers: adminHeaders(), cache: "no-store" });
        const refreshedBody = await refreshed.json().catch(() => ({}));
        if (refreshed.ok) {
          selectedEtag = typeof refreshedBody.currentEtag === "string" ? refreshedBody.currentEtag : selectedEtag;
          renderDetail(refreshedBody.version);
        }
        setDetailError("线上文档刚刚发生变化，已刷新校验状态。请再次确认后回滚。");
        restoreButton.disabled = false;
        return;
      }
      throw new Error(body.error || `回滚失败（${response.status}）`);
    }

    dialog.close();
    document.dispatchEvent(new CustomEvent("emby-icons:document-restored", { detail: body }));
  } catch (error) {
    setDetailError(error.message);
    restoreButton.disabled = false;
  }
}

function openVersions() {
  if (!dialog) return;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  loadVersions();
}

openButton?.addEventListener("click", openVersions);
closeButton?.addEventListener("click", () => dialog?.close());
refreshButton?.addEventListener("click", () => loadVersions());
moreButton?.addEventListener("click", () => loadVersions({ append: true }));
restoreButton?.addEventListener("click", restoreSelectedVersion);
dialog?.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});
