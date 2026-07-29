const list = document.querySelector("#moderation-list");
const status = document.querySelector("#moderation-status");
const refreshButton = document.querySelector("#moderation-refresh");

function adminHeaders() {
  const token = sessionStorage.getItem("emby-icons-admin-token") || "";
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function setStatus(message, error = false) {
  status.textContent = message;
  status.style.color = error ? "var(--danger)" : "";
}

function makeItem(item) {
  const article = document.createElement("article");
  article.className = "moderation-item";
  const image = document.createElement("img");
  image.src = item.url;
  image.alt = item.name;
  image.referrerPolicy = "no-referrer";
  const content = document.createElement("div");
  const name = document.createElement("h3");
  name.textContent = item.name;
  const url = document.createElement("p");
  url.textContent = item.url;
  const note = document.createElement("p");
  note.textContent = item.note ? `说明：${item.note}` : "没有补充说明";
  content.append(name, url, note);
  const actions = document.createElement("div");
  actions.className = "moderation-actions";
  const approve = document.createElement("button");
  approve.className = "button button-primary";
  approve.type = "button";
  approve.textContent = "通过并发布";
  const reject = document.createElement("button");
  reject.className = "button button-secondary danger";
  reject.type = "button";
  reject.textContent = "拒绝";
  approve.addEventListener("click", () => decide(item.id, "approve", actions));
  reject.addEventListener("click", async () => {
    const noteText = window.prompt("拒绝原因（可选）", "");
    if (noteText !== null) await decide(item.id, "reject", actions, noteText);
  });
  actions.append(approve, reject);
  article.append(image, content, actions);
  return article;
}

async function decide(id, action, actions, note = "") {
  actions.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  try {
    const response = await fetch(`/api/admin/submissions/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ action, note }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `操作失败（${response.status}）`);
    await loadQueue();
  } catch (error) {
    setStatus(error.message, true);
    actions.querySelectorAll("button").forEach((button) => { button.disabled = false; });
  }
}

async function loadQueue() {
  refreshButton.disabled = true;
  setStatus("正在加载待审核提交…");
  try {
    const response = await fetch("/api/admin/submissions?status=pending", { headers: adminHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `加载失败（${response.status}）`);
    list.replaceChildren(...(body.submissions || []).map(makeItem));
    setStatus(`当前有 ${body.submissions?.length || 0} 条待审核提交。`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton?.addEventListener("click", loadQueue);
loadQueue();
