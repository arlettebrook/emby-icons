import { hasAdminAccess } from "./admin.js";
import { findIconNameConflict, readDocument, suggestIconNames, writeAuditLog } from "./icons.js";

const SETTINGS_KEY = "settings/telegram.json";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_TOKEN_LENGTH = 256;
const MAX_CHAT_ID_LENGTH = 256;
const REVIEW_TIMEOUT_MS = 10 * 60 * 1000;
const REJECT_REASONS = ["图片模糊或质量不佳", "图标重复，无需收录", "图片无法访问"];

function responseHeaders(request) {
  return {
    "Access-Control-Allow-Origin": new URL(request.url).origin,
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  };
}

function jsonResponse(request, body, init = {}) {
  const headers = new Headers(responseHeaders(request));
  Object.entries(init.headers || {}).forEach(([name, value]) => headers.set(name, value));
  return new Response(JSON.stringify(body), { ...init, headers });
}

function toBase64(bytes) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);
  return new Uint8Array([...binary].map((character) => character.charCodeAt(0)));
}

async function encryptionKey(env) {
  const secret = String(env.ADMIN_TOKEN || "").trim();
  if (!secret) throw new Error("ADMIN_TOKEN is not configured");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`emby-icons:telegram:${secret}`),
  );
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptToken(token, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(env),
    new TextEncoder().encode(token),
  );
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(encrypted)) };
}

async function decryptToken(record, env) {
  if (!record?.iv || !record?.ciphertext) return "";
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(record.iv) },
    await encryptionKey(env),
    fromBase64(record.ciphertext),
  );
  return new TextDecoder().decode(decrypted);
}

function createSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readSettings(env) {
  if (!env.EMBY_ICONS) throw new Error("EMBY_ICONS KV is not configured");
  const raw = await env.EMBY_ICONS.get(SETTINGS_KEY);
  if (!raw) return { enabled: false, chatId: "", token: "" };
  try {
    const parsed = JSON.parse(raw);
    return {
      enabled: parsed.enabled === true,
      chatId: typeof parsed.chatId === "string" ? parsed.chatId : "",
      token: await decryptToken(parsed.token, env),
      webhookSecret: await decryptToken(parsed.webhookSecret, env),
    };
  } catch {
    throw new Error("Telegram settings are invalid or cannot be decrypted");
  }
}

function publicSettings(settings) {
  return {
    enabled: settings.enabled,
    configured: Boolean(settings.token),
    chatId: settings.chatId,
    webhookConfigured: Boolean(settings.webhookSecret),
  };
}

async function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return jsonResponse(request, { error: "ADMIN_TOKEN is not configured" }, { status: 503 });
  if (!(await hasAdminAccess(request, env))) return jsonResponse(request, { error: "Invalid admin session" }, { status: 401 });
  return null;
}

async function readBody(request) {
  const declaredSize = Number(request.headers.get("Content-Length") || 0);
  if (declaredSize > MAX_BODY_BYTES) throw new Error("Request body is too large");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) throw new Error("Request body is too large");
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new Error("Request body is not valid JSON");
  }
}

async function telegramApi(token, method, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok !== true) throw new Error(body.description || `Telegram request failed (${response.status})`);
    return body.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function setTelegramWebhook(token, origin, secret) {
  await telegramApi(token, "setWebhook", {
    url: `${origin}/api/telegram/webhook/${secret}`,
    secret_token: secret,
    allowed_updates: ["callback_query", "message"],
  });
}

async function ensureWebhookForSettings(env, settings, origin) {
  if (settings.webhookSecret || !origin) return false;
  const webhookSecret = createSecret();
  const record = {
    version: 1,
    enabled: settings.enabled,
    chatId: settings.chatId,
    token: await encryptToken(settings.token, env),
    webhookSecret: await encryptToken(webhookSecret, env),
    updatedAt: Date.now(),
  };
  await env.EMBY_ICONS.put(SETTINGS_KEY, JSON.stringify(record));
  await setTelegramWebhook(settings.token, origin, webhookSecret);
  settings.webhookSecret = webhookSecret;
  return true;
}

async function sendTelegramMessage(token, chatId, text, replyMarkup) {
  return telegramApi(token, "sendMessage", {
    chat_id: chatId,
    text: truncate(text, 4096),
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

function truncate(value, limit) {
  const text = String(value || "");
  if (text.length <= limit) return text;
  // Avoid splitting emoji/surrogate pairs at a truncation boundary.
  return text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, "") + "…";
}

// Rebuild cards from submission data instead of appending to callback.message.text.
// Keep valid URLs intact; budget the optional detail against the message limit.
function submissionMessage(submission, status = "🕓 待审核", detail = "") {
  const header = [
    "🖼 Emby 图标审核",
    `名称：${truncate(submission.name, 120)}`,
    `URL：${truncate(submission.url, 2048)}`,
    `说明：${truncate(submission.note || "无", 500)}`,
    `编号：${submission.id}`,
  ].join("\n");
  let text = `${header}\n\n${truncate(status, 1200)}`;
  const remaining = Math.min(800, 4096 - text.length - 2);
  if (detail && remaining > 0) text += `\n\n${truncate(detail, remaining)}`;
  return text;
}

function submissionKeyboard(id) {
  return {
    inline_keyboard: [
      [
        { text: "✅ 通过并发布", callback_data: `approve:${id}` },
        { text: "❌ 拒绝…", callback_data: `reject:${id}` },
      ],
      [{ text: "✏️ 改名并通过…", callback_data: `rename-manual:${id}` }],
    ],
  };
}

function conflictStateKey(id) {
  return `settings/telegram/conflict/${id}`;
}

function conflictKeyboard(id, suggestions) {
  const list = (Array.isArray(suggestions) ? suggestions : []).filter((name) => typeof name === "string" && name.trim());
  const rows = [];
  // Offer a single one-tap suggestion plus a manual rename so reviewers can
  // type any name instead of being limited to generated suggestions.
  if (list[0]) rows.push([{ text: `✏️ 用建议名通过：${truncate(list[0], 32)}`, callback_data: `rename:${id}:0` }]);
  rows.push([{ text: "✏️ 改名并通过…", callback_data: `rename-manual:${id}` }]);
  rows.push([
    { text: "♻️ 替换现有…", callback_data: `replace:${id}` },
    { text: "❌ 拒绝…", callback_data: `reject:${id}` },
  ]);
  return { inline_keyboard: rows };
}

function conflictNotice(name, body) {
  const suggestions = Array.isArray(body?.suggestions)
    ? body.suggestions.filter((item) => typeof item === "string" && item.trim())
    : [];
  const existing = typeof body?.conflict?.name === "string" ? body.conflict.name : "";
  const lines = [`⚠️ 名称冲突：图标名「${name}」已存在${existing && existing !== name ? `（现有：${existing}）` : ""}。`];
  if (suggestions.length) lines.push(`建议改名：${suggestions.join("、")}`);
  lines.push("请选择处理方式：");
  return { text: lines.join("\n"), suggestions };
}

async function readReviewSubmission(env, id) {
  if (!env.DB) throw new Error("审核数据库未配置");
  return env.DB.prepare(
    "SELECT id, name, url, note, status, reviewer_note FROM submissions WHERE id = ?1",
  ).bind(id).first();
}

function manualRenamePromptText(name, suggestion) {
  return [
    "✏️ 请直接回复新的图标名称，发送后将改名并通过审核。",
    `当前名称：${name}`,
    suggestion && suggestion !== name ? `冲突可用：${suggestion}` : "",
    "10 分钟内有效 · 发送 /cancel 或点击卡片上的取消按钮",
  ].filter(Boolean).join("\n");
}

async function readSuggestedName(env, id, index) {
  const raw = await env.EMBY_ICONS.get(conflictStateKey(id));
  if (!raw) return "";
  try {
    const suggestions = JSON.parse(raw)?.suggestions;
    return Array.isArray(suggestions) && typeof suggestions[index] === "string" ? suggestions[index] : "";
  } catch {
    return "";
  }
}

async function findSubmissionConflict(env, name, strict = false) {
  if (!env.EMBY_ICONS) {
    if (strict) throw new Error("无法读取已发布图标，暂不能确认替换");
    return null;
  }
  if (!name) return null;
  try {
    const current = await readDocument(env);
    if (current.text === null) return null;
    const document = JSON.parse(current.text);
    if (!Array.isArray(document?.icons)) throw new Error("已发布图标数据格式无效");
    const conflict = findIconNameConflict(document.icons, name);
    if (!conflict) return null;
    return { conflict, suggestions: suggestIconNames(name, document.icons, 2) };
  } catch (error) {
    if (strict) throw error;
    return null;
  }
}

export async function handleAdminTelegramSettings(request, env) {
  const authError = await requireAdmin(request, env);
  if (authError) return authError;
  if (!env.EMBY_ICONS) return jsonResponse(request, { error: "EMBY_ICONS KV is not configured" }, { status: 503 });

  let current;
  try {
    current = await readSettings(env);
  } catch (error) {
    // Allow an administrator to replace a stale/corrupt record by submitting a new Token.
    if (request.method !== "PUT") return jsonResponse(request, { error: error.message }, { status: 500 });
    current = { enabled: false, chatId: "", token: "" };
  }

  if (request.method === "GET") return jsonResponse(request, publicSettings(current));
  if (request.method !== "PUT") return jsonResponse(request, { error: "Method not allowed" }, { status: 405 });

  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    return jsonResponse(request, { error: error.message }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse(request, { error: "Request body must be an object" }, { status: 400 });
  }

  const enabled = body.enabled === true;
  const chatId = body.chatId === undefined ? current.chatId : String(body.chatId).trim();
  if (chatId.length > MAX_CHAT_ID_LENGTH) return jsonResponse(request, { error: "chatId is too long" }, { status: 400 });

  let token = current.token;
  if (body.clearBotToken === true) token = "";
  if (typeof body.botToken === "string" && body.botToken.trim()) token = body.botToken.trim();
  if (token.length > MAX_TOKEN_LENGTH) return jsonResponse(request, { error: "botToken is too long" }, { status: 400 });
  if (enabled && !token) return jsonResponse(request, { error: "启用通知前请填写 Bot Token" }, { status: 400 });
  if (enabled && !chatId) return jsonResponse(request, { error: "启用通知前请填写 Chat ID" }, { status: 400 });

  const webhookSecret = current.webhookSecret || createSecret();
  const record = {
    version: 1,
    enabled,
    chatId,
    token: token ? await encryptToken(token, env) : null,
    webhookSecret: token ? await encryptToken(webhookSecret, env) : null,
    updatedAt: Date.now(),
  };
  try {
    await env.EMBY_ICONS.put(SETTINGS_KEY, JSON.stringify(record));
  } catch {
    return jsonResponse(request, { error: "Telegram 配置保存失败，请检查 EMBY_ICONS KV 绑定" }, { status: 503 });
  }
  try {
    await writeAuditLog(env, {
      actorId: "admin",
      action: "telegram-settings-updated",
      targetId: SETTINGS_KEY,
      details: { enabled, configured: Boolean(token), chatId },
    });
  } catch (error) {
    console.error("Telegram settings audit log failed", error);
  }
  let webhookConfigured = false;
  let webhookWarning = "";
  if (token && enabled && chatId) {
    try {
      await setTelegramWebhook(token, new URL(request.url).origin, webhookSecret);
      webhookConfigured = true;
    } catch (error) {
      webhookWarning = "配置已保存，但 Telegram Webhook 设置失败，请检查站点是否可被公网访问。";
      await writeAuditLog(env, {
        actorId: "system",
        action: "telegram-webhook-failed",
        targetId: SETTINGS_KEY,
        details: { error: String(error.message || "Webhook setup failed").slice(0, 240) },
      }).catch(() => {});
    }
  } else if (token) {
    try {
      await telegramApi(token, "deleteWebhook", { drop_pending_updates: false });
    } catch {
      // Disabling notifications should still succeed when Telegram is unreachable.
    }
  }
  return jsonResponse(request, { ...publicSettings({ enabled, chatId, token, webhookSecret }), webhookConfigured, warning: webhookWarning });
}

export async function notifyNewSubmission(env, submission, origin = "") {
  const settings = await readSettings(env);
  if (!settings.enabled || !settings.token || !settings.chatId) return false;
  if (!settings.webhookSecret) {
    try {
      await ensureWebhookForSettings(env, settings, origin);
    } catch (error) {
      await writeAuditLog(env, {
        actorId: "system",
        action: "telegram-webhook-migration-failed",
        targetId: submission.id,
        details: { error: String(error.message || "Webhook migration failed").slice(0, 240) },
      }).catch(() => {});
    }
  }
  let text = submissionMessage(submission);
  let keyboard = settings.webhookSecret ? submissionKeyboard(submission.id) : null;
  const existing = await findSubmissionConflict(env, submission.name);
  if (existing) {
    const notice = conflictNotice(submission.name, { conflict: existing.conflict, suggestions: existing.suggestions });
    text = `${text}\n\n${notice.text}`;
    if (settings.webhookSecret) {
      await env.EMBY_ICONS.put(conflictStateKey(submission.id), JSON.stringify({
        id: submission.id,
        name: submission.name,
        suggestions: notice.suggestions,
        createdAt: Date.now(),
      }));
      keyboard = conflictKeyboard(submission.id, notice.suggestions);
    }
  }
  await sendTelegramMessage(settings.token, settings.chatId, text, keyboard);
  return true;
}

export async function queueSubmissionNotification(env, submission, waitUntil, origin = "") {
  const task = notifyNewSubmission(env, submission, origin).catch(async (error) => {
    await writeAuditLog(env, {
      actorId: "system",
      action: "telegram-notification-failed",
      targetId: submission.id,
      details: { error: String(error.message || "Telegram notification failed").slice(0, 240) },
    });
  });
  if (typeof waitUntil === "function") waitUntil(task);
  else await task;
}

// A single input flow per reviewer avoids consuming a rejection reason as a name.
function reviewStateKey(chatId, userId) {
  return `settings/telegram/review/${encodeURIComponent(chatId)}/${encodeURIComponent(userId)}`;
}

async function readReviewState(env, key) {
  const raw = await env.EMBY_ICONS.get(key);
  if (!raw) return null;
  try {
    const state = JSON.parse(raw);
    if (state?.id && state.messageId && state.userId && state.nonce && ["rename", "reject", "replace"].includes(state.action)) return state;
  } catch { /* Discard malformed state without treating a reply as a decision. */ }
  await env.EMBY_ICONS.delete(key);
  return null;
}

async function saveReviewState(env, key, state) {
  // Keep expired state briefly so the next interaction can restore its card.
  await env.EMBY_ICONS.put(key, JSON.stringify(state), { expirationTtl: 24 * 60 * 60 });
}

function expired(state) {
  return !Number.isFinite(state.createdAt) || Date.now() - state.createdAt > REVIEW_TIMEOUT_MS;
}

function stateMessage(settings, state) {
  return { chat: { id: settings.chatId }, message_id: state.messageId };
}

async function editCard(settings, message, submission, status, keyboard = { inline_keyboard: [] }, detail = "") {
  if (!message?.message_id) return false;
  try {
    await telegramApi(settings.token, "editMessageText", {
      chat_id: settings.chatId,
      message_id: message.message_id,
      text: submissionMessage(submission, status, detail),
      disable_web_page_preview: true,
      reply_markup: keyboard,
    });
    return true;
  } catch (error) {
    // A duplicate webhook may redraw the same card. That is already success.
    if (/message is not modified/i.test(error.message)) return true;
    return false;
  }
}

async function saveConflict(env, id, name, body) {
  const notice = conflictNotice(name, body);
  await env.EMBY_ICONS.put(conflictStateKey(id), JSON.stringify({
    id, name, suggestions: notice.suggestions, createdAt: Date.now(),
  }), { expirationTtl: 24 * 60 * 60 });
  return notice;
}

function resolvedStatus(submission) {
  if (!submission) return "⚪ 提交不存在或已删除";
  if (submission.status === "approved") return "✅ 已通过并发布";
  if (submission.status === "rejected") return `❌ 已拒绝\n原因：${submission.reviewer_note || "未填写拒绝原因"}`;
  if (submission.status === "withdrawn") return "↩️ 投稿人已撤回，无需审核";
  return "⏳ 发布状态待同步，请点击重试";
}

async function refreshCard(env, settings, message, submission, detail = "") {
  if (submission.status !== "pending") {
    const keyboard = submission.status === "approving"
      ? { inline_keyboard: [[{ text: "🔄 重试发布同步", callback_data: `approve:${submission.id}` }]] }
      : { inline_keyboard: [] };
    return editCard(settings, message, submission, resolvedStatus(submission), keyboard, detail);
  }
  const conflict = await findSubmissionConflict(env, submission.name);
  if (conflict) {
    const notice = await saveConflict(env, submission.id, submission.name, conflict);
    return editCard(settings, message, submission, "⚠️ 待审核 · 名称冲突", conflictKeyboard(submission.id, notice.suggestions), [detail, notice.text].filter(Boolean).join("\n"));
  }
  await env.EMBY_ICONS.delete(conflictStateKey(submission.id)).catch(() => {});
  return editCard(settings, message, submission, "🕓 待审核", submissionKeyboard(submission.id), detail);
}

async function retirePrompt(settings, state, text = "本次输入已结束，请使用审核卡片上的按钮继续。") {
  if (!state?.promptMessageId) return;
  await telegramApi(settings.token, "editMessageText", {
    chat_id: settings.chatId,
    message_id: state.promptMessageId,
    text: `${text}\n编号：${state.id}`,
    reply_markup: { inline_keyboard: [] },
  }).catch(() => {});
}

async function clearState(env, settings, key, state) {
  if (!state) return;
  await env.EMBY_ICONS.delete(key);
  await retirePrompt(settings, state);
}

async function restoreStateCard(env, settings, state, detail) {
  const row = await readReviewSubmission(env, state.id);
  if (row) await refreshCard(env, settings, stateMessage(settings, state), row, detail);
}

async function answerCallback(token, callbackId, text) {
  await telegramApi(token, "answerCallbackQuery", {
    callback_query_id: callbackId, text: truncate(text, 180), show_alert: false,
  });
}

async function executeAdminDecision(request, env, id, action, note = "", name = "") {
  const { handleAdminSubmissionDecision } = await import("./submissions.js");
  return handleAdminSubmissionDecision(
    new Request(request.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action, note, ...(name ? { name } : {}) }),
    }), env, id,
  );
}

function cancelButton(state) {
  return { text: "↩️ 取消，返回审核", callback_data: `cancel:${state.id}:${state.nonce}` };
}

function inputKeyboard(state) {
  const rows = [];
  if (state.action === "reject") {
    REJECT_REASONS.forEach((reason, index) => rows.push([
      { text: `❌ ${reason}`, callback_data: `reject-preset:${state.id}:${state.nonce}:${index}` },
    ]));
    rows.push([{ text: "不填原因，确认拒绝", callback_data: `reject-empty:${state.id}:${state.nonce}` }]);
  }
  if (state.action === "replace") {
    rows.push([{ text: "⚠️ 确认替换并发布", callback_data: `replace-confirm:${state.id}:${state.nonce}` }]);
  }
  rows.push([cancelButton(state)]);
  return { inline_keyboard: rows };
}

async function sendInputPrompt(env, settings, key, state, row, detail = "") {
  const suggestion = state.action === "rename" ? await readSuggestedName(env, row.id, 0) : "";
  const text = state.action === "rename"
    ? manualRenamePromptText(row.name, suggestion)
    : [
      `📝 请直接回复「${row.name}」的拒绝原因。`,
      "也可点击卡片上的常用原因；不填原因可发送 /reject 或 /skip。",
      "10 分钟内有效 · 发送 /cancel 或点击卡片上的取消按钮",
    ].join("\n");
  const prompt = await telegramApi(settings.token, "sendMessage", {
    chat_id: settings.chatId,
    text: [`${state.userName}，`, detail, text, `编号：${row.id}`].filter(Boolean).join("\n"),
    entities: [{
      type: "text_mention", offset: 0, length: state.userName.length,
      user: { id: Number(state.userId), is_bot: false, first_name: state.userName },
    }],
    disable_web_page_preview: true,
    reply_markup: {
      force_reply: true,
      selective: true,
      input_field_placeholder: state.action === "rename" ? "新名称（发送后通过审核）" : "输入拒绝原因",
    },
  });
  const oldPrompt = state.promptMessageId;
  state.promptMessageId = prompt.message_id;
  await saveReviewState(env, key, state);
  if (oldPrompt && oldPrompt !== state.promptMessageId) {
    await retirePrompt(settings, { ...state, promptMessageId: oldPrompt }, "请回复最新的输入提示。");
  }
}

async function beginInput(env, settings, key, previous, message, row, action, reviewer) {
  if (previous) {
    await clearState(env, settings, key, previous);
    if (previous.id !== row.id || previous.messageId !== message.message_id) {
      await restoreStateCard(env, settings, previous, "↩️ 已切换到另一条审核，原操作已取消。");
    }
  }
  const state = {
    id: row.id, action, messageId: message.message_id,
    userId: String(reviewer.id), userName: truncate(reviewer.first_name || "审核人", 40),
    nonce: createSecret().slice(0, 8), createdAt: Date.now(),
  };
  let status;
  if (action === "replace") {
    let conflict;
    try {
      conflict = await findSubmissionConflict(env, row.name, true);
    } catch {
      await refreshCard(env, settings, message, row, "无法确认现有图标状态，替换操作尚未开始。");
      await sendTelegramMessage(settings.token, settings.chatId, "无法读取当前图标库，已恢复审核卡片，请稍后重试替换。");
      return;
    }
    state.conflict = conflict ? { name: conflict.conflict.name, url: conflict.conflict.url } : null;
    status = conflict
      ? `⚠️ 确认替换「${conflict.conflict.name}」？\n将覆盖该条目的图片地址，其他图标不受影响。\n现有 URL：${truncate(conflict.conflict.url, 600)}\n10 分钟内有效，请确认后发布。`
      : "当前已无同名图标，确认后将直接发布。";
  } else {
    status = action === "rename"
      ? "⏳ 等待新名称 · 回复下方提示后将改名并通过"
      : "⏳ 等待拒绝原因 · 点击常用原因即拒绝，或回复下方提示自定义";
  }
  await saveReviewState(env, key, state);
  const edited = await editCard(settings, message, row, status, inputKeyboard(state));
  if (!edited) {
    await clearState(env, settings, key, state);
    await sendTelegramMessage(settings.token, settings.chatId, "审核卡片更新失败，尚未提交操作，请重新点击原按钮。");
    return;
  }
  if (action !== "replace") {
    try {
      await sendInputPrompt(env, settings, key, state, row);
    } catch {
      await clearState(env, settings, key, state);
      await refreshCard(env, settings, message, row, "输入提示发送失败，请重新操作。");
    }
  }
}

async function finishDecision(request, env, settings, key, state, message, row, action, note = "", name = "") {
  const response = await executeAdminDecision(request, env, row.id, action, note, name);
  const body = await response.json().catch(() => ({}));
  const latest = await readReviewSubmission(env, row.id);
  if (response.ok) {
    if (state?.id === row.id) await clearState(env, settings, key, state);
    await env.EMBY_ICONS.delete(conflictStateKey(row.id)).catch(() => {});
    const label = action === "replace" ? "♻️ 已替换现有图标并发布"
      : action === "approve-rename" ? `✅ 已改名为「${latest?.name || name}」并通过`
        : resolvedStatus(latest || row);
    const edited = await editCard(settings, message, latest || row, label);
    if (!edited) {
      // A completed decision must remain visible even if its original card was deleted.
      await sendTelegramMessage(settings.token, settings.chatId, submissionMessage(latest || row, label));
    }
    return;
  }
  if (latest && !["pending", "approving"].includes(latest.status)) {
    if (state?.id === row.id) await clearState(env, settings, key, state);
    await refreshCard(env, settings, message, latest);
    return;
  }
  if (body.code === "ICON_NAME_CONFLICT") {
    const notice = await saveConflict(env, row.id, name || row.name, body);
    const keyboard = conflictKeyboard(row.id, notice.suggestions);
    if (state?.id === row.id && state.action === "rename") {
      keyboard.inline_keyboard.push([cancelButton(state)]);
      await editCard(settings, message, latest || row, "⚠️ 名称冲突 · 可继续输入新名称", keyboard, notice.text);
      await sendInputPrompt(env, settings, key, state, latest || row, notice.text);
    } else {
      await editCard(settings, message, latest || row, "⚠️ 名称冲突", keyboard, notice.text);
    }
    return;
  }
  const errorText = `审核未完成：${truncate(body.error || "处理失败，请重试", 240)}`;
  if (state?.id === row.id && state.action !== "replace") {
    await sendInputPrompt(env, settings, key, state, latest || row, errorText);
  } else {
    if (latest) await refreshCard(env, settings, message, latest, errorText);
    await sendTelegramMessage(settings.token, settings.chatId, errorText);
  }
}

async function handleCallbackUpdate(request, env, settings, callback) {
  const chatId = String(callback.message?.chat?.id || "");
  const userId = String(callback.from?.id || "");
  if (chatId !== settings.chatId || !userId || callback.from?.is_bot) {
    await answerCallback(settings.token, callback.id, "此聊天或操作人未授权").catch(() => {});
    return;
  }
  const match = /^(approve|reject|replace|rename-manual|rename|cancel|reject-preset|reject-empty|replace-confirm):([0-9a-f-]{36})(?::([0-9a-f]{1,8}))?(?::([0-2]))?$/i.exec(String(callback.data || ""));
  if (!match) {
    await answerCallback(settings.token, callback.id, "无效的审核操作").catch(() => {});
    return;
  }
  // Stop Telegram's button spinner before any database/publication work.
  await answerCallback(settings.token, callback.id, "正在处理审核…").catch(() => {});
  const action = match[1].toLowerCase();
  const id = match[2];
  const key = reviewStateKey(chatId, userId);
  let state = await readReviewState(env, key);
  const row = await readReviewSubmission(env, id);
  if (!row) {
    if (state?.id === id) await clearState(env, settings, key, state);
    await editCard(settings, callback.message, { id }, resolvedStatus(null));
    return;
  }
  if (row.status !== "pending" && !(row.status === "approving" && action === "approve")) {
    if (state?.id === id) await clearState(env, settings, key, state);
    await refreshCard(env, settings, callback.message, row);
    return;
  }
  if (["cancel", "reject-preset", "reject-empty", "replace-confirm"].includes(action)) {
    const expectedAction = action.startsWith("reject-") ? "reject" : "replace";
    if (!state || state.id !== id || state.nonce !== match[3] || state.messageId !== callback.message.message_id
      || (action !== "cancel" && state.action !== expectedAction)) {
      await sendTelegramMessage(settings.token, settings.chatId, "此按钮已失效或属于其他审核人，请使用自己的最新审核操作。");
      return;
    }
    if (expired(state) || action === "cancel") {
      const detail = expired(state) ? "⏱️ 操作已超时，请重新审核。" : `↩️ 已取消${state.action === "rename" ? "改名" : state.action === "reject" ? "拒绝" : "替换"}操作。`;
      await clearState(env, settings, key, state);
      await refreshCard(env, settings, callback.message, row, detail);
      return;
    }
    if (action === "replace-confirm") {
      const current = await findSubmissionConflict(env, row.name, true);
      const conflict = current ? { name: current.conflict.name, url: current.conflict.url } : null;
      if (JSON.stringify(conflict) !== JSON.stringify(state.conflict)) {
        await beginInput(env, settings, key, state, callback.message, row, "replace", callback.from);
        await sendTelegramMessage(settings.token, settings.chatId, "同名图标已发生变化，请核对新的替换确认卡片。");
        return;
      }
      await finishDecision(request, env, settings, key, state, callback.message, row, "replace");
      return;
    }
    if (action === "reject-preset" && match[4] === undefined) return;
    const reason = action === "reject-preset" ? REJECT_REASONS[Number(match[4])] : "";
    await finishDecision(request, env, settings, key, state, callback.message, row, "reject", reason);
    return;
  }
  if (["reject", "rename-manual", "replace"].includes(action)) {
    await beginInput(env, settings, key, state, callback.message, row, action === "rename-manual" ? "rename" : action, callback.from);
    return;
  }
  let name = "";
  if (action === "rename") {
    name = await readSuggestedName(env, id, Number(match[3] || 0));
    if (!name) {
      await refreshCard(env, settings, callback.message, row, "改名建议已失效，已刷新可用操作。");
      return;
    }
  }
  await finishDecision(request, env, settings, key, state, callback.message, row, action === "rename" ? "approve-rename" : "approve", "", name);
}

async function cancelLegacyInput(env, settings, chatId) {
  let restored = false;
  // Pre-upgrade prompts were chat-scoped. Never apply their text to a decision;
  // /cancel only restores their cards so the reviewer can restart safely.
  for (const action of ["rename", "reject"]) {
    const key = `settings/telegram/${action}/${encodeURIComponent(chatId)}`;
    const raw = await env.EMBY_ICONS.get(key);
    if (!raw) continue;
    let old;
    try { old = JSON.parse(raw); } catch { /* Invalid legacy state is discarded. */ }
    if (old?.id && old.messageId) {
      await restoreStateCard(env, settings, old, "↩️ 旧版输入已取消，请重新选择审核操作。");
      restored = true;
    }
    await env.EMBY_ICONS.delete(key);
  }
  return restored;
}

async function handleMessageUpdate(env, settings, message) {
  const chatId = String(message?.chat?.id || "");
  const userId = String(message.from?.id || "");
  if (chatId !== settings.chatId || !userId || message.from?.is_bot) return;
  const key = reviewStateKey(chatId, userId);
  const state = await readReviewState(env, key);
  const text = String(message.text || "").trim();
  const command = /^\/(cancel|reject|skip)(?:@[^\s]+)?(?:\s+(.*))?$/is.exec(text);
  if (!state) {
    if (command?.[1].toLowerCase() === "cancel" && await cancelLegacyInput(env, settings, chatId)) {
      await sendTelegramMessage(settings.token, settings.chatId, "旧版输入已取消，审核按钮已恢复，请重新选择。");
      return;
    }
    if (command) await sendTelegramMessage(settings.token, settings.chatId, "当前没有等待中的审核操作，请先点击审核卡片上的按钮。");
    return;
  }
  const row = await readReviewSubmission(env, state.id);
  if (!row || !["pending", "approving"].includes(row.status)) {
    await clearState(env, settings, key, state);
    if (row) await refreshCard(env, settings, stateMessage(settings, state), row);
    await sendTelegramMessage(settings.token, settings.chatId, resolvedStatus(row));
    return;
  }
  if (expired(state)) {
    await clearState(env, settings, key, state);
    await refreshCard(env, settings, stateMessage(settings, state), row, "⏱️ 操作已超时，请重新审核。");
    await sendTelegramMessage(settings.token, settings.chatId, "操作已超时，审核按钮已恢复，请重新选择。");
    return;
  }
  const replyId = message.reply_to_message?.message_id;
  const isPrivate = message.chat.type === "private";
  // Private chats retain free-text input. Groups must reply to the exact prompt,
  // preventing unrelated chatter or an old reply from reviewing another item.
  if ((replyId && replyId !== state.promptMessageId) || (!isPrivate && !replyId)) return;
  if (command?.[1].toLowerCase() === "cancel") {
    await clearState(env, settings, key, state);
    await refreshCard(env, settings, stateMessage(settings, state), row,
      `↩️ 已取消${state.action === "rename" ? "改名" : state.action === "reject" ? "拒绝" : "替换"}操作。`);
    return;
  }
  if (state.action === "replace") {
    await sendTelegramMessage(settings.token, settings.chatId, "请使用卡片上的确认替换或取消按钮，文字回复不会发布。");
    return;
  }
  if (!text) {
    await sendInputPrompt(env, settings, key, state, row, "请发送文字内容，不支持图片、贴纸或附件。");
    return;
  }
  const isRejectCommand = state.action === "reject" && ["reject", "skip"].includes(command?.[1].toLowerCase());
  if (text.startsWith("/") && !isRejectCommand) {
    await sendInputPrompt(env, settings, key, state, row, "请回复所需文字，或发送 /cancel 取消。");
    return;
  }
  const value = isRejectCommand ? (command[2] || "").trim() : text;
  const limit = state.action === "rename" ? 120 : 1000;
  if (value.length > limit || (state.action === "rename" && !value)) {
    await sendInputPrompt(env, settings, key, state, row,
      state.action === "rename" ? "图标名称需为 1-120 个字符，请重新回复。" : "拒绝原因不能超过 1000 个字符，请重新回复。");
    return;
  }
  await finishDecision(new Request("https://telegram-webhook.invalid"), env, settings, key, state,
    stateMessage(settings, state), row, state.action === "rename" ? "approve-rename" : "reject",
    state.action === "reject" ? value : "", state.action === "rename" ? value : "");
}

export async function handleTelegramWebhook(request, env, secretParam) {
  if (!env.EMBY_ICONS) return new Response("Not found", { status: 404 });
  let settings;
  try {
    settings = await readSettings(env);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (!settings.enabled || !settings.token || !settings.webhookSecret || secretParam !== settings.webhookSecret) return new Response("Not found", { status: 404 });
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== settings.webhookSecret) return new Response("Not found", { status: 404 });

  let update;
  try {
    update = await request.json();
    if (update.callback_query) await handleCallbackUpdate(request, env, settings, update.callback_query);
    else if (update.message) await handleMessageUpdate(env, settings, update.message);
  } catch (error) {
    await writeAuditLog(env, {
      actorId: "telegram",
      action: "telegram-webhook-failed",
      details: { error: String(error.message || "Webhook processing failed").slice(0, 240) },
    }).catch(() => {});
    const sourceMessage = update?.callback_query?.message || update?.message;
    const sender = update?.callback_query?.from || update?.message?.from;
    if (String(sourceMessage?.chat?.id || "") === settings.chatId && sender?.id && !sender.is_bot) {
      await sendTelegramMessage(settings.token, settings.chatId,
        "审核服务暂时异常，请查看卡片状态后重试。若图标已发布，重试会同步已有结果，不会重复收录。").catch(() => {});
    }
  }
  return new Response("ok", { status: 200 });
}

export function handleTelegramOptions(request) {
  return new Response(null, { status: 204, headers: responseHeaders(request) });
}
