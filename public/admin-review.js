const list = document.querySelector("#moderation-list");
const status = document.querySelector("#moderation-status");
const refreshButton = document.querySelector("#moderation-refresh");
const dialog = document.querySelector("#moderation-dialog");
const openButton = document.querySelector("#moderation-open-button");
const closeButton = document.querySelector("#moderation-close-button");
const telegramEnabled = document.querySelector("#telegram-enabled");
const telegramBotDisabled = document.querySelector("#telegram-bot-disabled");
const telegramBotToken = document.querySelector("#telegram-bot-token");
const telegramChatId = document.querySelector("#telegram-chat-id");
const telegramTokenNote = document.querySelector("#telegram-token-note");
const telegramStatus = document.querySelector("#telegram-settings-status");
const telegramSaveButton = document.querySelector("#telegram-save-button");
const telegramSyncButton = document.querySelector("#telegram-sync-button");
const filter = document.querySelector("#moderation-filter");
const searchInput = document.querySelector("#moderation-search");
const reviewerFilter = document.querySelector("#moderation-reviewer");
const loadMoreButton = document.querySelector("#moderation-more");
const summary = document.querySelector("#moderation-summary");
const emptyState = document.querySelector("#moderation-empty");

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

function applyTelegramPowerState() {
  const disabled = telegramBotDisabled.checked;
  telegramSyncButton.disabled = disabled;
  telegramSyncButton.title = disabled ? "Bot 已关闭，请先取消彻底关闭并保存" : "";
}

async function loadTelegramSettings() {
  try {
    const response = await fetch("/api/admin/telegram", { headers: adminHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `加载 Telegram 配置失败（${response.status}）`);
    telegramEnabled.checked = body.enabled === true;
    telegramBotDisabled.checked = body.botDisabled === true;
    applyTelegramPowerState();
    telegramChatId.value = body.chatId || "";
    telegramBotToken.value = "";
    telegramBotToken.placeholder = body.configured ? "已配置，留空则保持当前 Token" : "粘贴 Bot Token";
    telegramTokenNote.textContent = body.configured
      ? "当前已配置 Bot Token；留空保存时不会覆盖它。"
      : "Token 会加密保存在服务端，不会回显到页面。";
    if (body.botDisabled) setTelegramStatus("Bot 已彻底关闭；Webhook 与命令菜单已注销，配置仍保留。", "warning");
    else setTelegramStatus(body.configured ? "Bot Token 已配置" : "尚未配置 Bot Token", body.configured ? "success" : "");
  } catch (error) {
    setTelegramStatus(error.message, "error");
  }
}

async function saveTelegramSettings() {
  telegramSaveButton.disabled = true;
  setTelegramStatus("正在保存…");
  const body = {
    enabled: telegramEnabled.checked,
    botDisabled: telegramBotDisabled.checked,
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
    telegramBotDisabled.checked = result.botDisabled === true;
    applyTelegramPowerState();
    telegramBotToken.value = "";
    telegramBotToken.placeholder = result.configured ? "已配置，留空则保持当前 Token" : "粘贴 Bot Token";
    telegramTokenNote.textContent = result.configured
      ? "当前已配置 Bot Token；留空保存时不会覆盖它。"
      : "Token 会加密保存在服务端，不会回显到页面。";
    if (result.warning) setTelegramStatus(result.warning, "warning");
    else if (result.botDisabled) setTelegramStatus("Bot 已彻底关闭；Webhook 已注销，命令菜单已删除。", "success");
    else if (!result.webhookConfigured && result.configured) setTelegramStatus("配置已保存；Webhook 尚未就绪，请点击「同步 Webhook」。", "warning");
    else setTelegramStatus(result.enabled ? "通知已开启；机器人命令保持可用。" : "通知已关闭；机器人命令保持可用。", "success");
  } catch (error) {
    setTelegramStatus(error.message, "error");
  } finally {
    telegramSaveButton.disabled = false;
  }
}

async function syncTelegramWebhook() {
  if (telegramBotDisabled.checked) {
    setTelegramStatus("Bot 已关闭，请先取消「彻底关闭 Bot」并保存设置。", "warning");
    return;
  }
  telegramSyncButton.disabled = true;
  setTelegramStatus("正在同步 Webhook 与命令菜单…");
  try {
    const response = await fetch("/api/admin/telegram", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ action: "sync" }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `同步 Webhook 失败（${response.status}）`);
    const pending = Number(result.webhook?.pendingUpdateCount || 0);
    const details = [];
    if (pending > 0) details.push(`待处理更新 ${pending} 条`);
    if (result.webhook?.matchesExpected === false) details.push("Telegram 端状态尚未更新");
    if (result.webhook?.lastErrorMessage) details.push(`最近错误：${result.webhook.lastErrorMessage}`);
    if (result.warning) details.push(result.warning);
    const suffix = details.length ? `（${details.join("；")}）` : "";
    setTelegramStatus(`Webhook 已同步，命令菜单已更新${suffix}。`, details.length ? "warning" : "success");
  } catch (error) {
    setTelegramStatus(error.message, "error");
  } finally {
    applyTelegramPowerState();
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

const PAGE_SIZE = 50;
let nextCursor = null;
let loadedCount = 0;
let searchTimer = 0;

function currentFilters() {
  return {
    status: filter?.value || "pending",
    q: String(searchInput?.value || "").trim(),
    reviewerId: reviewerFilter?.value || "",
  };
}

function updateSummary(stats = {}) {
  if (!summary) return;
  summary.textContent = `待审核 ${Number(stats.pending || 0)} · 发布中 ${Number(stats.approving || 0)} · 总计 ${Number(stats.total || 0)}`;
}

function updateReviewerOptions(stats = {}) {
  if (!reviewerFilter) return;
  const current = reviewerFilter.value;
  const reviewers = Object.keys(stats.byReviewer || {}).sort((a, b) => a.localeCompare(b));
  const options = [new Option("全部", "")];
  for (const id of reviewers) {
    options.push(new Option(id === "unreviewed" ? "未审核" : id, id));
  }
  reviewerFilter.replaceChildren(...options);
  if (current && reviewers.includes(current)) reviewerFilter.value = current;
}

async function loadQueue({ append = false } = {}) {
  refreshButton.disabled = true;
  if (loadMoreButton) loadMoreButton.disabled = true;
  const filters = currentFilters();
  if (!append) nextCursor = null;
  setStatus(append ? "正在加载更多…" : `正在加载${statusLabel(filters.status)}提交…`);
  const params = new URLSearchParams({ status: filters.status, limit: String(PAGE_SIZE) });
  if (filters.q) params.set("q", filters.q);
  if (filters.reviewerId) params.set("reviewerId", filters.reviewerId);
  if (append && nextCursor) params.set("cursor", nextCursor);
  try {
    const response = await fetch(`/api/admin/submissions?${params}`, { headers: adminHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `加载失败（${response.status}）`);
    const items = Array.isArray(body.submissions) ? body.submissions : [];
    const nodes = items.map(makeItem);
    if (append) {
      list.append(...nodes);
      loadedCount += items.length;
    } else {
      list.replaceChildren(...nodes);
      loadedCount = items.length;
    }
    nextCursor = body.nextCursor || null;
    if (loadMoreButton) loadMoreButton.hidden = !nextCursor;
    if (emptyState) emptyState.hidden = loadedCount > 0;
    updateSummary(body.stats);
    updateReviewerOptions(body.stats);
    setStatus(loadedCount === 0
      ? `没有符合条件的${statusLabel(filters.status)}提交。`
      : `已显示 ${loadedCount} 条${statusLabel(filters.status)}提交。`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    refreshButton.disabled = false;
    if (loadMoreButton) loadMoreButton.disabled = false;
  }
}

function reloadQueue() {
  return loadQueue();
}

refreshButton?.addEventListener("click", reloadQueue);
filter?.addEventListener("change", reloadQueue);
reviewerFilter?.addEventListener("change", reloadQueue);
loadMoreButton?.addEventListener("click", () => loadQueue({ append: true }));
searchInput?.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(reloadQueue, 350);
});
openButton?.addEventListener("click", () => dialog?.showModal());
closeButton?.addEventListener("click", () => dialog?.close());
dialog?.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});
telegramSaveButton?.addEventListener("click", saveTelegramSettings);
telegramSyncButton?.addEventListener("click", syncTelegramWebhook);
telegramBotDisabled?.addEventListener("change", () => {
  applyTelegramPowerState();
  setTelegramStatus(
    telegramBotDisabled.checked
      ? "保存后将注销 Webhook 并删除命令菜单。"
      : "保存后将重新启用 Bot 并恢复 Webhook 与命令菜单。",
    "warning",
  );
});
if (window.location.hash === "#moderation") dialog?.showModal();
loadQueue();
loadTelegramSettings();