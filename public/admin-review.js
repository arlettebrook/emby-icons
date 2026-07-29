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

function adminHeaders() {
  const token = sessionStorage.getItem("emby-icons-admin-token") || "";
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
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
openButton?.addEventListener("click", () => dialog?.showModal());
closeButton?.addEventListener("click", () => dialog?.close());
dialog?.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});
telegramSaveButton?.addEventListener("click", saveTelegramSettings);
if (window.location.hash === "#moderation") dialog?.showModal();
loadQueue();
loadTelegramSettings();
