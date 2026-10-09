const tokenInput = document.querySelector("#admin-token");
const loadButton = document.querySelector("#load-button");
const status = document.querySelector("#status");
const list = document.querySelector("#review-list");
const storageKey = "emby-icons-admin-token";

tokenInput.value = sessionStorage.getItem(storageKey) || "";

function headers() {
  return { Authorization: `Bearer ${tokenInput.value.trim()}`, "Content-Type": "application/json" };
}

function setStatus(message, error = false) {
  status.textContent = message;
  status.style.color = error ? "var(--danger)" : "";
}

function makeItem(item) {
  const article = document.createElement("article");
  article.className = "review-item";
  const image = document.createElement("img");
  image.src = item.url;
  image.alt = item.name;
  image.referrerPolicy = "no-referrer";
  image.onerror = () => { image.alt = "图片加载失败"; };
  const content = document.createElement("div");
  const title = document.createElement("h2");
  title.textContent = item.name;
  const url = document.createElement("p");
  url.textContent = item.url;
  const note = document.createElement("p");
  note.textContent = item.note ? `说明：${item.note}` : "没有补充说明";
  content.append(title, url, note);
  const actions = document.createElement("div");
  actions.className = "review-actions";

  if (item.conflict) {
    const warning = document.createElement("div");
    warning.className = "moderation-conflict";
    const warningTitle = document.createElement("strong");
    warningTitle.textContent = "名称冲突";
    const warningCopy = document.createElement("p");
    warningCopy.textContent = `已存在同名图标「${item.conflict.name}」（第 ${Number(item.conflict.index) + 1} 项）${item.conflict.sameUrl ? "，且图片地址相同。" : "。"}`;
    warning.append(warningTitle, warningCopy);
    if (Array.isArray(item.suggestions) && item.suggestions.length) {
      const suggestionCopy = document.createElement("p");
      suggestionCopy.textContent = `建议改名：${item.suggestions.join("、")}`;
      warning.append(suggestionCopy);
    }
    content.append(warning);

    const rename = document.createElement("button");
    rename.className = "button button-primary";
    rename.type = "button";
    rename.textContent = "改名后通过";
    const replace = document.createElement("button");
    replace.className = "button button-secondary danger";
    replace.type = "button";
    replace.textContent = "替换现有";
    const reject = document.createElement("button");
    reject.className = "button button-secondary danger";
    reject.type = "button";
    reject.textContent = "拒绝";

    rename.addEventListener("click", async () => {
      const suggested = item.suggestions?.[0] || `${item.name}01`;
      const nextName = window.prompt("请输入新的图标名称", suggested);
      if (nextName === null) return;
      const trimmedName = nextName.trim();
      if (!trimmedName) { setStatus("图标名称不能为空", true); return; }
      await decide(item.id, "approve-rename", actions, { name: trimmedName });
    });
    replace.addEventListener("click", async () => {
      if (!window.confirm(`确定用该提交替换现有图标「${item.conflict.name}」吗？原有名称和图片地址会被覆盖。`)) return;
      await decide(item.id, "replace", actions);
    });
    reject.addEventListener("click", async () => {
      const noteText = window.prompt("拒绝原因（可选）", "");
      if (noteText !== null) await decide(item.id, "reject", actions, { note: noteText });
    });
    actions.append(rename, replace, reject);
  } else {
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
      if (noteText === null) return;
      await decide(item.id, "reject", actions, { note: noteText });
    });
    actions.append(approve, reject);
  }

  article.append(image, content, actions);
  return article;
}

async function decide(id, action, actionContainer, { note = "", name = "" } = {}) {
  actionContainer.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  try {
    const payload = { action, note };
    if (name) payload.name = name;
    const response = await fetch(`/api/admin/submissions/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (body.code === "ICON_NAME_CONFLICT") {
        const suggestions = Array.isArray(body.suggestions) && body.suggestions.length
          ? `，可尝试：${body.suggestions.join("、")}`
          : "";
        await loadSubmissions();
        setStatus(`${body.error || "图标名称冲突"}${suggestions}`, true);
        return;
      }
      throw new Error(body.error || `操作失败（${response.status}）`);
    }
    await loadSubmissions();
  } catch (error) {
    setStatus(error.message, true);
    actionContainer.querySelectorAll("button").forEach((button) => { button.disabled = false; });
  }
}

async function loadSubmissions() {
  const token = tokenInput.value.trim();
  if (!token) { setStatus("请输入管理员令牌。", true); return; }
  loadButton.disabled = true;
  setStatus("正在加载…");
  try {
    const response = await fetch("/api/admin/submissions?status=pending", { headers: headers(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `加载失败（${response.status}）`);
    sessionStorage.setItem(storageKey, token);
    list.replaceChildren(...(body.submissions || []).map(makeItem));
    setStatus(`共有 ${body.submissions?.length || 0} 条待审核提交。`);
  } catch (error) {
    if (error.message.includes("Invalid admin token")) sessionStorage.removeItem(storageKey);
    setStatus(error.message, true);
  } finally {
    loadButton.disabled = false;
  }
}

loadButton.addEventListener("click", loadSubmissions);
