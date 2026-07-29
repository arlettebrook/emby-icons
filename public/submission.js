const list = document.querySelector("#submission-list");
const empty = document.querySelector("#submission-empty");
const info = document.querySelector("#submission-info");
const editForm = document.querySelector("#edit-form");
const result = document.querySelector("#result");
const withdrawButton = document.querySelector("#withdraw-button");
const queryId = new URLSearchParams(window.location.search).get("id");
let currentId = "";
let currentToken = "";

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

function showResult(message, error = false) {
  result.hidden = false;
  result.textContent = message;
  result.classList.toggle("error", error);
}

function statusLabel(status) {
  return { pending: "待审核", approving: "发布中", approved: "已发布", rejected: "已拒绝", withdrawn: "已撤回" }[status] || status;
}

function renderSubmissionInfo(submission) {
  info.replaceChildren();
  const rows = [
    ["状态", statusLabel(submission.status)],
    ["编号", submission.id],
    ["名称", submission.name],
    ["图标 URL", submission.url],
    ["提交时间", new Date(submission.created_at).toLocaleString()],
  ];
  if (submission.reviewer_note) rows.push(["审核备注", submission.reviewer_note]);
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
  const editable = submission.status === "pending";
  editForm.hidden = !editable;
  if (editable) {
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
  info.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function loadOne(reference) {
  try {
    const response = await fetch(`/api/submissions/${encodeURIComponent(reference.id)}`, {
      headers: { "X-Submission-Token": reference.token },
      cache: "no-store",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `查询失败（${response.status}）`);
    saveSubmissionReference(reference.id, reference.token);
    return { submission: body.submission, token: reference.token };
  } catch (error) {
    return { error: error.message, id: reference.id };
  }
}

async function loadAll() {
  const references = readSavedSubmissions();
  if (!references.length) {
    empty.hidden = false;
    return;
  }
  const loaded = await Promise.all(references.map(loadOne));
  const valid = loaded.filter((item) => item.submission);
  renderList(valid);
  const selected = valid.find((item) => item.submission.id === queryId) || valid[0];
  if (selected) selectSubmission(selected.submission.id, selected.token, selected.submission);
  const failed = loaded.find((item) => item.error);
  if (failed && !valid.length) showResult("暂时无法读取保存的提交记录，请重新提交或检查浏览器存储。", true);
}

async function saveSubmission(event) {
  event.preventDefault();
  try {
    const response = await fetch(`/api/submissions/${encodeURIComponent(currentId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Submission-Token": currentToken },
      body: JSON.stringify({
        name: document.querySelector("#edit-name").value,
        url: document.querySelector("#edit-url").value,
        note: document.querySelector("#edit-note").value,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `保存失败（${response.status}）`);
    renderSubmissionInfo(body.submission);
    showResult("修改已保存。", false);
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
    editForm.hidden = true;
    showResult("提交已撤回。", false);
    await loadAll();
  } catch (error) {
    showResult(error.message, true);
  }
}

editForm.addEventListener("submit", saveSubmission);
withdrawButton.addEventListener("click", withdrawSubmission);
loadAll();
