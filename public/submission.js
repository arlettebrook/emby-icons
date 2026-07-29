const query = new URLSearchParams(window.location.search);
const idInput = document.querySelector("#submission-id");
const tokenInput = document.querySelector("#access-token");
const lookupForm = document.querySelector("#lookup-form");
const editForm = document.querySelector("#edit-form");
const info = document.querySelector("#submission-info");
const result = document.querySelector("#result");
const withdrawButton = document.querySelector("#withdraw-button");
let currentId = "";
let currentToken = "";

idInput.value = query.get("id") || "";

function showResult(message, error = false) {
  result.hidden = false;
  result.textContent = message;
  result.classList.toggle("error", error);
}

function tokenStorageKey(id) {
  return `emby-submission-token:${id}`;
}

function renderSubmission(submission) {
  info.replaceChildren();
  const rows = [
    ["状态", submission.status],
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

async function loadSubmission(event) {
  event?.preventDefault();
  currentId = idInput.value.trim();
  currentToken = tokenInput.value.trim();
  if (!currentId || !currentToken) return showResult("请输入提交编号和访问凭证。", true);
  try {
    const response = await fetch(`/api/submissions/${encodeURIComponent(currentId)}`, {
      headers: { "X-Submission-Token": currentToken },
      cache: "no-store",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `查询失败（${response.status}）`);
    localStorage.setItem(tokenStorageKey(currentId), currentToken);
    renderSubmission(body.submission);
    showResult("查询成功。", false);
  } catch (error) {
    showResult(error.message, true);
  }
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
    renderSubmission(body.submission);
    showResult("修改已保存。", false);
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
    await loadSubmission();
  } catch (error) {
    showResult(error.message, true);
  }
}

const savedId = idInput.value.trim();
if (savedId) {
  const savedToken = localStorage.getItem(tokenStorageKey(savedId));
  if (savedToken) {
    tokenInput.value = savedToken;
    loadSubmission();
  }
}
lookupForm.addEventListener("submit", loadSubmission);
editForm.addEventListener("submit", saveSubmission);
withdrawButton.addEventListener("click", withdrawSubmission);
