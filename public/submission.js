const list = document.querySelector("#submission-list");
const empty = document.querySelector("#submission-empty");
const info = document.querySelector("#submission-info");
const editForm = document.querySelector("#edit-form");
const result = document.querySelector("#result");
const withdrawButton = document.querySelector("#withdraw-button");
const saveButton = document.querySelector("#save-button");
const deleteButton = document.querySelector("#delete-button");
const recordActions = document.querySelector("#record-actions");
const resubmitHint = document.querySelector("#resubmit-hint");
const queryId = new URLSearchParams(window.location.search).get("id");
let currentId = "";
let currentToken = "";
let currentStatus = "";

function tokenStorageKey(id) {
  return `emby-submission-token:${id}`;
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

function showResult(message, error = false) {
  result.hidden = false;
  result.textContent = message;
  result.classList.toggle("error", error);
}

function statusLabel(status) {
  return { pending: "待审核", approving: "发布中", approved: "已发布", rejected: "已拒绝", withdrawn: "已撤回" }[status] || status;
}

function markActiveCard(id) {
  list.querySelectorAll(".submission-card").forEach((card) => {
    card.dataset.active = card.dataset.id === id ? "true" : "false";
  });
}

function renderSubmissionInfo(submission) {
  currentStatus = submission.status;
  info.replaceChildren();
  const rows = [
    ["状态", statusLabel(submission.status)],
    ["编号", submission.id],
    ["名称", submission.name],
    ["图标 URL", submission.url],
    ["提交时间", new Date(submission.created_at).toLocaleString()],
  ];
  if (submission.reviewer_note) {
    rows.push([submission.status === "rejected" ? "拒绝原因" : "审核备注", submission.reviewer_note]);
  }
  rows.forEach(([label, value]) => {
    const row = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = `${label}：`;
    const span = document.createElement("span");
    span.textContent = value;
    row.append(strong, span);
    info.append(row);
  });
  info.hidden = false;

  // 待审核可以改；被拒绝/已撤回可以改好后重新提交，所以编辑表单也要露出来。
  const editable = submission.status === "pending";
  const resubmittable = submission.status === "rejected" || submission.status === "withdrawn";
  const formVisible = editable || resubmittable;
  editForm.hidden = !formVisible;
  saveButton.textContent = editable ? "保存修改" : "重新提交审核";
  withdrawButton.hidden = !editable;
  resubmitHint.hidden = !resubmittable;
  // 发布中不允许删除（服务端会拒绝），这里也把按钮收起来，避免点了才报错。
  recordActions.hidden = submission.status === "approving";
  if (formVisible) {
    document.querySelector("#edit-name").value = submission.name;
    document.querySelector("#edit-url").value = submission.url;
    document.querySelector("#edit-note").value = submission.note || "";
  }
}

function renderList(items) {
  list.replaceChildren();
  empty.hidden = items.length > 0;
  items.forEach(({ submission, token }) => {
    const card = document.createElement("article");
    card.className = "submission-card";
    card.dataset.id = submission.id;
    const content = document.createElement("div");
    const title = document.createElement("h2");
    title.textContent = submission.name;
    const state = document.createElement("p");
    state.className = "submission-status";
    state.textContent = `状态：${statusLabel(submission.status)}`;
    const id = document.createElement("p");
    id.textContent = `编号：${submission.id}`;
    content.append(title, state, id);
    const button = document.createElement("button");
    button.className = "button button-secondary";
    button.type = "button";
    button.textContent = "查看详情";
    button.addEventListener("click", () => selectSubmission(submission.id, token, submission));
    card.append(content, button);
    list.append(card);
  });
}

function selectSubmission(id, token, submission) {
  currentId = id;
  currentToken = token;
  renderSubmissionInfo(submission);
  markActiveCard(id);
  info.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function loadOne(reference) {
  let status = 0;
  try {
    const response = await fetch(`/api/submissions/${encodeURIComponent(reference.id)}`, {
      headers: { "X-Submission-Token": reference.token },
      cache: "no-store",
    });
    status = response.status;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `查询失败（${response.status}）`);
    saveSubmissionReference(reference.id, reference.token);
    return { submission: body.submission, token: reference.token };
  } catch (error) {
    // 404 说明记录已经不存在（例如在别处删除了），可以安全地清掉本地引用。
    return { error: error.message, missing: status === 404, id: reference.id };
  }
}

function resetDetailPanel() {
  currentId = "";
  currentToken = "";
  currentStatus = "";
  info.hidden = true;
  editForm.hidden = true;
  recordActions.hidden = true;
}

async function loadAll() {
  const references = readSavedSubmissions();
  if (!references.length) {
    list.replaceChildren();
    resetDetailPanel();
    empty.hidden = false;
    return;
  }
  const loaded = await Promise.all(references.map(loadOne));
  // 服务端已经不存在的记录直接从本地清掉，避免列表里留下点不开的幽灵条目。
  loaded.filter((item) => item.missing).forEach((item) => removeSavedSubmission(item.id));
  const valid = loaded.filter((item) => item.submission);
  renderList(valid);
  const selected = valid.find((item) => item.submission.id === queryId) || valid[0];
  if (selected) selectSubmission(selected.submission.id, selected.token, selected.submission);
  else resetDetailPanel();
  empty.hidden = valid.length > 0;
  const failed = loaded.find((item) => item.error);
  if (failed && !valid.length) showResult("暂时无法读取保存的提交记录，请重新提交或检查浏览器存储。", true);
}

async function saveSubmission(event) {
  event.preventDefault();
  const payload = {
    name: document.querySelector("#edit-name").value,
    url: document.querySelector("#edit-url").value,
    note: document.querySelector("#edit-note").value,
  };
  // 非待审核的记录走「重新提交」：服务端会把它改回待审核队列并重新通知审核人。
  if (currentStatus !== "pending") payload.resubmit = true;
  try {
    const response = await fetch(`/api/submissions/${encodeURIComponent(currentId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Submission-Token": currentToken },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `保存失败（${response.status}）`);
    if (body.submission) renderSubmissionInfo(body.submission);
    showResult(body.resubmitted ? "已重新提交，等待审核。" : "修改已保存。", false);
    await loadAll();
  } catch (error) {
    showResult(error.message, true);
  }
}

async function withdrawSubmission() {
  if (!window.confirm("确定撤回这条待审核提交吗？")) return;
  try {
    const response = await fetch(`/api/submissions/${encodeURIComponent(currentId)}`, {
      method: "POST",
      headers: { "X-Submission-Token": currentToken },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `撤回失败（${response.status}）`);
    showResult("提交已撤回，可修改后重新提交。", false);
    await loadAll();
  } catch (error) {
    showResult(error.message, true);
  }
}

async function deleteSubmission() {
  if (!currentId) return;
  if (!window.confirm("确定删除这条提交记录吗？删除后本页面不再显示它，仍在待审核的提交也会一并从队列移除，且无法恢复。如果已经发布，图标本身不会被下架。")) return;
  const id = currentId;
  try {
    const response = await fetch(`/api/submissions/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "X-Submission-Token": currentToken },
    });
    // 记录已不存在（404）同样按删除成功处理，否则本地残留永远清不掉。
    if (!response.ok && response.status !== 404) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `删除失败（${response.status}）`);
    }
    removeSavedSubmission(id);
    resetDetailPanel();
    showResult("提交记录已删除。", false);
    await loadAll();
  } catch (error) {
    showResult(error.message, true);
  }
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

editForm.addEventListener("submit", saveSubmission);
withdrawButton.addEventListener("click", withdrawSubmission);
deleteButton.addEventListener("click", deleteSubmission);
loadAll();
initTelegramWebApp();
