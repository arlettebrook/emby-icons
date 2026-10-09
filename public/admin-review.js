const list = document.querySelector("#moderation-list");
const status = document.querySelector("#moderation-status");
const refreshButton = document.querySelector("#moderation-refresh");
const dialog = document.querySelector("#moderation-dialog");
const openButton = document.querySelector("#moderation-open-button");
const closeButton = document.querySelector("#moderation-close-button");
const telegramEnabled = document.querySelector("#telegram-enabled");
const telegramBotToken = document.querySelector("#telegram-bot-token");
const telegramChatId = document.querySelector("#telegram-chat-id");
const telegramTokenNote = document.querySelector("#telegram-token-note");
const telegramStatus = document.querySelector("#telegram-settings-status");
const telegramSaveButton = document.querySelector("#telegram-save-button");
const filter = document.querySelector("#moderation-filter");

function adminHeaders() {
  const token = sessionStorage.getItem("emby-icons-admin-token") || "";
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function statusLabel(status) {
  return {
    pending: "待审核",
    approving: "发布中",
    approved: "已通过",
    rejected: "已拒绝",
    withdrawn: "已撤回",
    all: "全部",
  }[status] || status;
}

function setStatus(message, error = false) {
  status.textContent = message;
  status.style.color = error ? "var(--danger)" : "";
}

function setTelegramStatus(message, type = "") {
  telegramStatus.textContent = message;
  telegramStatus.className = `telegram-settings-status${type ? ` is-${type}` : ""}`;
}

async function loadTelegramSettings() {
  try {
    const response = await fetch("/api/admin/telegram", { headers: adminHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `加载 Telegram 配置失败（${response.status}）`);
    telegramEnabled.checked = body.enabled === true;
    telegramChatId.value = body.chatId || "";
    telegramBotToken.value = "";
    telegramBotToken.placeholder = body.configured ? "已配置，留空则保持当前 Token" : "粘贴 Bot Token";
    telegramTokenNote.textContent = body.configured
      ? "当前已配置 Bot Token；留空保存时不会覆盖它。"
      : "Token 会加密保存在服务端，不会回显到页面。";
    setTelegramStatus(body.configured ? "Bot Token 已配置" : "尚未配置 Bot Token", body.configured ? "success" : "");
  } catch (error) {
    setTelegramStatus(error.message, "error");
  }
}

async function saveTelegramSettings() {
  telegramSaveButton.disabled = true;
  setTelegramStatus("正在保存…");
  const body = {
    enabled: telegramEnabled.checked,
    chatId: telegramChatId.value.trim(),
  };
  if (telegramBotToken.value.trim()) body.botToken = telegramBotToken.value.trim();
  try {
    const response = await fetch("/api/admin/telegram", {
      method: "PUT",
      headers: adminHeaders(),
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `保存 Telegram 配置失败（${response.status}）`);
    telegramBotToken.value = "";
    telegramBotToken.placeholder = result.configured ? "已配置，留空则保持当前 Token" : "粘贴 Bot Token";
    telegramTokenNote.textContent = result.configured
      ? "当前已配置 Bot Token；留空保存时不会覆盖它。"
      : "Token 会加密保存在服务端，不会回显到页面。";
    if (result.warning) setTelegramStatus(result.warning, "error");
    else if (result.enabled && !result.webhookConfigured) setTelegramStatus("配置已保存，但 Webhook 尚未就绪", "error");
    else setTelegramStatus(result.enabled ? "通知已开启，保存成功" : "通知已关闭，保存成功", "success");
  } catch (error) {
    setTelegramStatus(error.message, "error");
  } finally {
    telegramSaveButton.disabled = false;
  }
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

  const reviewed = Boolean(item.status) && item.status !== "pending";
  if (reviewed) {
    const outcome = document.createElement("p");
    const reason = item.reviewer_note ? `：${item.reviewer_note}` : "";
    const when = item.reviewed_at ? `（${new Date(Number(item.reviewed_at)).toLocaleString()}）` : "";
    outcome.textContent = `审核结果：${statusLabel(item.status)}${reason}${when}`;
    content.append(outcome);
  }

  const actions = document.createElement("div");
  actions.className = "moderation-actions";

  if (reviewed) {
    // Reviewed submissions are read-only; the outcome above is enough.
  } else if (item.conflict) {
    const warning = document.createElement("div");
    warning.className = "moderation-conflict";
    const warningTitle = document.createElement("strong");
    warningTitle.textContent = "名称冲突";
    const warningCopy = document.createElement("p");
    warningCopy.textContent = `已存在同名图标「${item.conflict.name}」（第 ${Number(item.conflict.index) + 1} 项）${item.conflict.sameUrl ? "，且图片地址相同，可能是上次发布未完成。" : "。"}`;
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
      if (!trimmedName) {
        setStatus("图标名称不能为空", true);
        return;
      }
      await decide(item.id, "approve-rename", actions, { name: trimmedName });
    });
    replace.addEventListener("click", async () => {
      if (!window.confirm(`确定用该提交替换现有图标「${item.conflict.name}」吗？原有名称和图片地址会被覆盖。`)) return;
      await decide(item.id, "replace", actions);
    });
    reject.addEventListener("click", async () => {
      const noteText = window.prompt("拒绝原因（可留空，会展示给提交者）", "");
      if (noteText !== null) await decide(item.id, "reject", actions, { note: noteText });
    });
    actions.append(rename, replace, reject);
  } else {
    const approve = document.createElement("button");
    approve.className = "button button-primary";
    approve.type = "button";
    approve.textContent = "通过并发布";
    const rename = document.createElement("button");
    rename.className = "button button-secondary";
    rename.type = "button";
    rename.textContent = "改名后通过";
    const reject = document.createElement("button");
    reject.className = "button button-secondary danger";
    reject.type = "button";
    reject.textContent = "拒绝";
    approve.addEventListener("click", () => decide(item.id, "approve", actions));
    rename.addEventListener("click", async () => {
      const suggested = item.suggestions?.[0] || `${item.name}01`;
      const nextName = window.prompt("请输入新的图标名称", suggested);
      if (nextName === null) return;
      const trimmedName = nextName.trim();
      if (!trimmedName) {
        setStatus("图标名称不能为空", true);
        return;
      }
      await decide(item.id, "approve-rename", actions, { name: trimmedName });
    });
    reject.addEventListener("click", async () => {
      const noteText = window.prompt("拒绝原因（可留空，会展示给提交者）", "");
      if (noteText !== null) await decide(item.id, "reject", actions, { note: noteText });
    });
    actions.append(approve, rename, reject);
  }

  article.append(image, content, actions);
  return article;
}

async function decide(id, action, actions, { note = "", name = "" } = {}) {
  actions.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  try {
    const payload = { action, note };
    if (name) payload.name = name;
    const response = await fetch(`/api/admin/submissions/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (body.code === "ICON_NAME_CONFLICT") {
        const suggestions = Array.isArray(body.suggestions) && body.suggestions.length
          ? `，可尝试：${body.suggestions.join("、")}`
          : "";
        await loadQueue();
        setStatus(`${body.error || "图标名称冲突"}${suggestions}`, true);
        return;
      }
      throw new Error(body.error || `操作失败（${response.status}）`);
    }
    if (action === "reject") {
      await loadQueue();
      setStatus(`已拒绝该提交${note.trim() ? `，拒绝原因：${note.trim()}` : "（未填写拒绝原因）"}。`);
      return;
    }
    await loadQueue();
  } catch (error) {
    setStatus(error.message, true);
    actions.querySelectorAll("button").forEach((button) => { button.disabled = false; });
  }
}

async function loadQueue() {
  refreshButton.disabled = true;
  const statusFilter = filter?.value || "pending";
  setStatus(`正在加载${statusLabel(statusFilter)}提交…`);
  try {
    const response = await fetch(`/api/admin/submissions?status=${encodeURIComponent(statusFilter)}`, { headers: adminHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `加载失败（${response.status}）`);
    list.replaceChildren(...(body.submissions || []).map(makeItem));
    setStatus(`当前有 ${body.submissions?.length || 0} 条${statusLabel(statusFilter)}提交。`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton?.addEventListener("click", loadQueue);
filter?.addEventListener("change", loadQueue);
openButton?.addEventListener("click", () => dialog?.showModal());
closeButton?.addEventListener("click", () => dialog?.close());
dialog?.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});
telegramSaveButton?.addEventListener("click", saveTelegramSettings);
if (window.location.hash === "#moderation") dialog?.showModal();
loadQueue();
loadTelegramSettings();
