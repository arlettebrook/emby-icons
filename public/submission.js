const list = document.querySelector("#submission-list");
const empty = document.querySelector("#submission-empty");
const detail = document.querySelector("#submission-detail");
const info = document.querySelector("#submission-info");
const detailName = document.querySelector("#detail-name");
const detailBadge = document.querySelector("#detail-badge");
const detailThumbSlot = document.querySelector("#detail-thumb-slot");
const countWrap = document.querySelector("#submission-count");
const countValue = document.querySelector("#submission-count-value");
const editForm = document.querySelector("#edit-form");
const nameInput = document.querySelector("#edit-name");
const urlInput = document.querySelector("#edit-url");
const noteInput = document.querySelector("#edit-note");
const saveButton = document.querySelector("#save-button");
const withdrawButton = document.querySelector("#withdraw-button");
const withdrawCancel = document.querySelector("#withdraw-cancel");
const deleteButton = document.querySelector("#delete-button");
const deleteCancel = document.querySelector("#delete-cancel");
const recordActions = document.querySelector("#record-actions");
const resubmitHint = document.querySelector("#resubmit-hint");
const result = document.querySelector("#result");
const queryId = new URLSearchParams(window.location.search).get("id");
let currentId = "";
let currentToken = "";
let currentStatus = "";

const STATUS_META = {
  pending: { label: "待审核", className: "pending" },
  approving: { label: "发布中", className: "approving" },
  approved: { label: "已发布", className: "approved" },
  rejected: { label: "已拒绝", className: "rejected" },
  withdrawn: { label: "已撤回", className: "withdrawn" },
};

function statusMeta(status) {
  return STATUS_META[status] || { label: status || "未知", className: "" };
}

function tokenStorageKey(id) {
  return "emby-submission-token:" + id;
}

function readSavedSubmissions() {
  try {
    const values = JSON.parse(localStorage.getItem("emby-submissions") || "[]");
    const saved = Array.isArray(values) ? values.filter((item) => item?.id && item?.token) : [];
    const known = new Set(saved.map((item) => item.id));
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index) || "";
      if (!key.startsWith("emby-submission-token:")) continue;
      const id = key.slice("emby-submission-token:".length);
      const token = localStorage.getItem(key) || "";
      if (id && token && !known.has(id)) saved.push({ id, token });
    }
    return saved;
  } catch {
    return [];
  }
}

function saveSubmissionReference(id, token) {
  const next = readSavedSubmissions().filter((item) => item.id !== id);
  next.unshift({ id, token });
  localStorage.setItem("emby-submissions", JSON.stringify(next.slice(0, 30)));
  localStorage.setItem(tokenStorageKey(id), token);
}

// 删除本地记录：列表条目和单独的 token 键都要清掉，否则下次加载会出现幽灵条目。
function removeSavedSubmission(id) {
  try {
    localStorage.setItem("emby-submissions", JSON.stringify(readSavedSubmissions().filter((item) => item.id !== id)));
    localStorage.removeItem(tokenStorageKey(id));
  } catch {
    // 浏览器存储不可用时忽略；刷新后会以服务端结果为准。
  }
}

function applyBadge(element, status) {
  const meta = statusMeta(status);
  element.textContent = meta.label;
  element.className = meta.className ? "status-badge " + meta.className : "status-badge";
}

function showResult(message, error = false) {
  result.hidden = false;
  result.textContent = message;
  result.classList.toggle("error", error);
  result.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value || "—") : date.toLocaleString();
}

// 缩略图加载失败时用占位方块兜底，避免列表里留下破图。
function iconThumb(url, variant) {
  const img = document.createElement("img");
  img.className = variant === "detail" ? "detail-thumb" : "card-thumb";
  img.alt = "";
  img.decoding = "async";
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  img.addEventListener("error", () => {
    const fallback = document.createElement("span");
    fallback.className = variant === "detail" ? "detail-thumb-fallback" : "card-thumb-fallback";
    fallback.textContent = "?";
    fallback.setAttribute("aria-hidden", "true");
    img.replaceWith(fallback);
  });
  img.src = url;
  return img;
}

function markActiveCard(id) {
  list.querySelectorAll(".submission-card").forEach((card) => {
    const active = card.dataset.id === id;
    card.dataset.active = active ? "true" : "false";
    if (active) card.setAttribute("aria-current", "true");
    else card.removeAttribute("aria-current");
  });
}

function metaRow(label, value, options) {
  const settings = options || {};
  const row = document.createElement("div");
  row.className = settings.span ? "meta-row span-2" : "meta-row";
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  if (settings.node) dd.append(settings.node);
  else dd.textContent = value;
  row.append(dt, dd);
  return row;
}

function buildUrlValue(url) {
  const wrap = document.createElement("span");
  wrap.className = "meta-inline";
  const link = document.createElement("a");
  link.className = "meta-link";
  link.href = url;
  link.target = "_blank";
  link.rel = "noreferrer noopener";
  link.textContent = url;
  link.title = url;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy-button";
  copy.textContent = "复制";
  copy.addEventListener("click", () => copyText(url, copy));
  wrap.append(link, copy);
  return wrap;
}

function fallbackCopy(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

async function copyText(text, button) {
  const original = button.textContent;
  button.textContent = "复制中…";
  let ok = false;
  // 部分 WebView 里 clipboard 写入会一直悬着，这里加超时兜底，保证按钮一定有反馈。
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      ok = await Promise.race([
        navigator.clipboard.writeText(text).then(() => true),
        new Promise((resolve) => window.setTimeout(() => resolve(false), 700)),
      ]);
    } catch {
      ok = false;
    }
  }
  if (!ok) ok = fallbackCopy(text);
  button.textContent = ok ? "已复制" : "复制失败";
  window.setTimeout(() => {
    button.textContent = original;
  }, 1600);
}

function renderMeta(submission) {
  info.replaceChildren(
    metaRow("状态", statusMeta(submission.status).label),
    metaRow("提交时间", formatTime(submission.created_at)),
    metaRow("名称", submission.name, { span: true }),
    metaRow("编号", submission.id, { span: true }),
    metaRow("图标 URL", "", { span: true, node: buildUrlValue(submission.url) }),
  );
  if (submission.reviewer_note) {
    info.append(
      metaRow(submission.status === "rejected" ? "拒绝原因" : "审核备注", submission.reviewer_note, { span: true }),
    );
  }
}

function renderSubmissionInfo(submission) {
  // 换到另一条记录时，之前的「待确认」按钮不应该还亮着。
  resetConfirmFlows();
  currentStatus = submission.status;
  detailName.textContent = submission.name;
  applyBadge(detailBadge, submission.status);
  detailThumbSlot.replaceChildren(iconThumb(submission.url, "detail"));
  renderMeta(submission);

  // 待审核可以改；被拒绝/已撤回可以改好后重新提交，所以编辑表单也要露出来。
  const editable = submission.status === "pending";
  const resubmittable = submission.status === "rejected" || submission.status === "withdrawn";
  const formVisible = editable || resubmittable;
  editForm.hidden = !formVisible;
  saveButton.textContent = editable ? "保存修改" : "重新提交审核";
  withdrawButton.hidden = !editable;
  resubmitHint.hidden = !resubmittable;
  // 发布中不允许删除（服务端会拒绝），这里也把入口收起来，避免点了才报错。
  recordActions.hidden = submission.status === "approving";
  if (formVisible) {
    nameInput.value = submission.name;
    urlInput.value = submission.url;
    noteInput.value = submission.note || "";
  }
  detail.hidden = false;
}

function renderList(items) {
  list.replaceChildren();
  countValue.textContent = String(items.length);
  countWrap.hidden = items.length === 0;
  empty.hidden = items.length > 0;
  items.forEach(({ submission, token }) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "submission-card";
    card.dataset.id = submission.id;
    card.dataset.active = "false";
    card.setAttribute("aria-label", submission.name + "，状态：" + statusMeta(submission.status).label + "，查看详情");

    const main = document.createElement("span");
    main.className = "card-main";
    const title = document.createElement("span");
    title.className = "card-title";
    title.textContent = submission.name;
    const sub = document.createElement("span");
    sub.className = "card-sub";
    const badge = document.createElement("span");
    applyBadge(badge, submission.status);
    const idText = document.createElement("span");
    idText.className = "card-id";
    idText.textContent = "#" + String(submission.id).slice(0, 8);
    sub.append(badge, idText);
    main.append(title, sub);

    const chevron = document.createElement("span");
    chevron.className = "card-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "›";

    card.append(iconThumb(submission.url, "card"), main, chevron);
    card.addEventListener("click", () => selectSubmission(submission.id, token, submission));
    list.append(card);
  });
}

function selectSubmission(id, token, submission, options) {
  const settings = options || {};
  currentId = id;
  currentToken = token;
  renderSubmissionInfo(submission);
  markActiveCard(id);
  if (settings.scroll !== false) detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function loadOne(reference) {
  let status = 0;
  try {
    const response = await fetch("/api/submissions/" + encodeURIComponent(reference.id), {
      headers: { "X-Submission-Token": reference.token },
      cache: "no-store",
    });
    status = response.status;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "查询失败（" + response.status + "）");
    saveSubmissionReference(reference.id, reference.token);
    return { submission: body.submission, token: reference.token };
  } catch (error) {
    // 404 说明记录已经不存在（例如在别处删除了），可以安全地清掉本地引用。
    return { error: error.message, missing: status === 404, id: reference.id };
  }
}

function resetDetailPanel() {
  resetConfirmFlows();
  currentId = "";
  currentToken = "";
  currentStatus = "";
  detail.hidden = true;
  editForm.hidden = true;
  recordActions.hidden = true;
  detailThumbSlot.replaceChildren();
}

async function loadAll() {
  const references = readSavedSubmissions();
  if (!references.length) {
    list.replaceChildren();
    resetDetailPanel();
    countWrap.hidden = true;
    empty.hidden = false;
    return;
  }
  const loaded = await Promise.all(references.map(loadOne));
  // 服务端已经不存在的记录直接从本地清掉，避免列表里留下点不开的幽灵条目。
  loaded.filter((item) => item.missing).forEach((item) => removeSavedSubmission(item.id));
  const valid = loaded.filter((item) => item.submission);
  renderList(valid);
  // 保存/撤回/重新提交后仍然停留在同一条记录上，只有它消失时才回退到首条。
  const selected =
    valid.find((item) => item.submission.id === currentId) ||
    valid.find((item) => item.submission.id === queryId) ||
    valid[0];
  if (selected) selectSubmission(selected.submission.id, selected.token, selected.submission, { scroll: false });
  else resetDetailPanel();
  const failed = loaded.find((item) => item.error);
  if (failed && !valid.length) showResult("暂时无法读取保存的提交记录，请重新提交或检查浏览器存储。", true);
}

// 统一的按钮忙碌态：禁用 + 换文案 + 转圈，结束后恢复（或按当前状态重算文案）。
async function runAction(button, busyLabel, action, finalLabel) {
  if (button.disabled) return;
  const original = button.textContent;
  button.disabled = true;
  button.dataset.busy = "true";
  button.textContent = busyLabel;
  try {
    await action();
  } finally {
    button.disabled = false;
    delete button.dataset.busy;
    button.textContent = typeof finalLabel === "function" ? finalLabel() : original;
  }
}

async function saveSubmission(event) {
  event.preventDefault();
  const payload = {
    name: nameInput.value,
    url: urlInput.value,
    note: noteInput.value,
  };
  // 非待审核的记录走「重新提交」：服务端会把它改回待审核队列并重新通知审核人。
  if (currentStatus !== "pending") payload.resubmit = true;
  const busyLabel = currentStatus === "pending" ? "保存中…" : "重新提交中…";
  await runAction(
    saveButton,
    busyLabel,
    async () => {
      withdrawButton.disabled = true;
      try {
        const response = await fetch("/api/submissions/" + encodeURIComponent(currentId), {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "X-Submission-Token": currentToken },
          body: JSON.stringify(payload),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "保存失败（" + response.status + "）");
        showResult(body.resubmitted ? "已重新提交，等待审核。" : "修改已保存。", false);
        await loadAll();
      } catch (error) {
        showResult(error.message, true);
      } finally {
        withdrawButton.disabled = false;
      }
    },
    () => (currentStatus === "pending" ? "保存修改" : "重新提交审核"),
  );
}

async function withdrawSubmission() {
  await runAction(withdrawButton, "撤回中…", async () => {
    try {
      const response = await fetch("/api/submissions/" + encodeURIComponent(currentId), {
        method: "POST",
        headers: { "X-Submission-Token": currentToken },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "撤回失败（" + response.status + "）");
      showResult("提交已撤回，可修改后重新提交。", false);
      await loadAll();
    } catch (error) {
      showResult(error.message, true);
    }
  });
}

async function deleteSubmission() {
  if (!currentId) return;
  const id = currentId;
  await runAction(deleteButton, "删除中…", async () => {
    try {
      const response = await fetch("/api/submissions/" + encodeURIComponent(id), {
        method: "DELETE",
        headers: { "X-Submission-Token": currentToken },
      });
      // 记录已不存在（404）同样按删除成功处理，否则本地残留永远清不掉。
      if (!response.ok && response.status !== 404) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "删除失败（" + response.status + "）");
      }
      removeSavedSubmission(id);
      resetDetailPanel();
      showResult("提交记录已删除。", false);
      await loadAll();
    } catch (error) {
      showResult(error.message, true);
    }
  });
}

// 作为 Telegram Mini App 打开时，通知 Telegram 页面已就绪并铺满可视区域；
// 在普通浏览器中 window.Telegram 不存在，直接跳过。
function initTelegramWebApp() {
  const tg = window.Telegram?.WebApp;
  if (!tg) return;
  try {
    tg.ready();
    tg.expand();
    document.documentElement.classList.add("telegram-webapp");
  } catch {
    // 旧版本 SDK 或非 Telegram 环境：忽略即可。
  }
}

// 两步确认：原生 confirm 弹窗在 Telegram Mini App 里很突兀，这里改成
// 「第一次点击进入待确认态 → 再点一次执行 / 点取消或 8 秒后自动还原」，降低误触。
const confirmFlows = [];

function resetConfirmFlows() {
  confirmFlows.forEach((flow) => flow.reset());
}

function createConfirmFlow(button, cancelButton, options) {
  const settings = options || {};
  let timer = 0;
  const api = {
    reset() {
      window.clearTimeout(timer);
      timer = 0;
      button.dataset.confirm = "false";
      button.textContent = settings.label;
      cancelButton.hidden = true;
    },
  };
  const arm = () => {
    confirmFlows.forEach((flow) => {
      if (flow !== api) flow.reset();
    });
    button.dataset.confirm = "true";
    button.textContent = settings.confirmLabel;
    cancelButton.hidden = false;
    window.clearTimeout(timer);
    timer = window.setTimeout(api.reset, 8000);
  };
  cancelButton.addEventListener("click", api.reset);
  button.addEventListener("click", async () => {
    if (button.dataset.confirm !== "true") {
      arm();
      return;
    }
    api.reset();
    await settings.action();
  });
  api.reset();
  confirmFlows.push(api);
  return api;
}

// 表单控件都是首次渲染就存在，这里直接绑定，避免依赖渲染顺序。
createConfirmFlow(withdrawButton, withdrawCancel, {
  label: "撤回提交",
  confirmLabel: "确认撤回",
  action: withdrawSubmission,
});
createConfirmFlow(deleteButton, deleteCancel, {
  label: "删除记录",
  confirmLabel: "确认删除",
  action: deleteSubmission,
});

editForm.addEventListener("submit", saveSubmission);
loadAll();
initTelegramWebApp();
