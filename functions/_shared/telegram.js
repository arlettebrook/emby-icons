import { hasAdminAccess } from "./admin.js";
import { writeAuditLog } from "./icons.js";

const SETTINGS_KEY = "settings/telegram.json";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_TOKEN_LENGTH = 256;
const MAX_CHAT_ID_LENGTH = 256;

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
    text,
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

function submissionMessage(submission) {
  return [
    "🔔 新的 Emby 图标提交",
    `名称：${submission.name}`,
    `URL：${submission.url}`,
    `说明：${submission.note || "无"}`,
    `编号：${submission.id}`,
    "请使用下方按钮进行审核。",
  ].join("\n");
}

function submissionKeyboard(id) {
  return {
    inline_keyboard: [[
      { text: "✅ 通过并发布", callback_data: `approve:${id}` },
      { text: "❌ 拒绝", callback_data: `reject:${id}` },
    ]],
  };
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
  await sendTelegramMessage(settings.token, settings.chatId, submissionMessage(submission), settings.webhookSecret ? submissionKeyboard(submission.id) : null);
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

function rejectStateKey(chatId) {
  return `settings/telegram/reject/${encodeURIComponent(chatId)}`;
}

async function editTelegramSubmission(token, message, suffix, replyMarkup = { inline_keyboard: [] }) {
  if (!message?.chat?.id || !message.message_id) return;
  const original = message.text || message.caption || "Emby 图标提交";
  await telegramApi(token, "editMessageText", {
    chat_id: message.chat.id,
    message_id: message.message_id,
    text: suffix ? `${original}\n\n${suffix}` : original,
    disable_web_page_preview: true,
    reply_markup: replyMarkup,
  });
}

async function restorePendingSubmission(settings, pending, suffix) {
  if (!pending?.messageId) return;
  await editTelegramSubmission(
    settings.token,
    { chat: { id: settings.chatId }, message_id: pending.messageId, text: pending.messageText || "Emby 图标提交" },
    suffix,
    submissionKeyboard(pending.id),
  ).catch(() => {});
}

async function answerCallback(token, callbackId, text) {
  await telegramApi(token, "answerCallbackQuery", { callback_query_id: callbackId, text, show_alert: false });
}

async function executeAdminDecision(request, env, id, action, note = "") {
  const { handleAdminSubmissionDecision } = await import("./submissions.js");
  return handleAdminSubmissionDecision(
    new Request(request.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action, note }),
    }),
    env,
    id,
  );
}

async function handleCallbackUpdate(request, env, settings, callback) {
  const chatId = String(callback.message?.chat?.id || "");
  if (!chatId || chatId !== settings.chatId) {
    await answerCallback(settings.token, callback.id, "此聊天未授权").catch(() => {});
    return;
  }
  const match = /^(approve|reject):([0-9a-f-]{36})$/i.exec(String(callback.data || ""));
  if (!match) {
    await answerCallback(settings.token, callback.id, "无效的审核操作").catch(() => {});
    return;
  }
  const [, action, id] = match;
  if (action.toLowerCase() === "approve") {
    const response = await executeAdminDecision(request, env, id, "approve");
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      await answerCallback(settings.token, callback.id, "已通过并发布").catch(() => {});
      await editTelegramSubmission(settings.token, callback.message, "✅ 已通过并发布").catch(() => {});
    } else {
      await answerCallback(settings.token, callback.id, body.error || "发布失败").catch(() => {});
      await sendTelegramMessage(settings.token, settings.chatId, `审核失败：${body.error || "无法发布该提交"}`).catch(() => {});
    }
    return;
  }

  await env.EMBY_ICONS.put(rejectStateKey(chatId), JSON.stringify({
    id,
    messageId: callback.message?.message_id || null,
    messageText: callback.message?.text || callback.message?.caption || "Emby 图标提交",
    createdAt: Date.now(),
  }));
  await answerCallback(settings.token, callback.id, "请回复拒绝原因").catch(() => {});
  await editTelegramSubmission(settings.token, callback.message, "⏳ 等待拒绝原因：请发送 /reject 拒绝原因").catch(() => {});
  await sendTelegramMessage(settings.token, settings.chatId, "请发送拒绝指令：\n/reject [可选的拒绝原因]\n\n直接发送 /reject 也可以拒绝。10 分钟内有效，发送 /cancel 可取消本次拒绝操作。").catch(() => {});
}

async function handleMessageUpdate(env, settings, message) {
  const chatId = String(message?.chat?.id || "");
  if (!chatId || chatId !== settings.chatId) return;
  const text = String(message.text || "").trim();
  if (!text) return;
  const key = rejectStateKey(chatId);
  const pendingRaw = await env.EMBY_ICONS.get(key);
  if (text.toLowerCase() === "/cancel") {
    if (!pendingRaw) {
      await sendTelegramMessage(settings.token, settings.chatId, "当前没有等待中的拒绝操作。");
      return;
    }
    try {
      const pending = JSON.parse(pendingRaw);
      await env.EMBY_ICONS.delete(key);
      await restorePendingSubmission(settings, pending, "↩️ 已取消拒绝操作，可重新审核。");
      await sendTelegramMessage(settings.token, settings.chatId, "已取消本次拒绝操作，审核按钮已恢复。");
    } catch {
      await env.EMBY_ICONS.delete(key);
      await sendTelegramMessage(settings.token, settings.chatId, "拒绝操作已失效，请重新点击审核消息中的按钮。");
    }
    return;
  }
  if (!/^\/reject(?:@[^\s]+)?(?:\s|$)/i.test(text)) return;
  if (!pendingRaw) {
    await sendTelegramMessage(settings.token, settings.chatId, "当前没有等待拒绝原因的提交，请先点击审核消息中的“拒绝”按钮。");
    return;
  }
  let pending;
  try {
    pending = JSON.parse(pendingRaw);
  } catch {
    await env.EMBY_ICONS.delete(key);
    await sendTelegramMessage(settings.token, settings.chatId, "拒绝操作已失效，请重新点击审核消息中的“拒绝”按钮。");
    return;
  }
  if (Date.now() - Number(pending.createdAt || 0) > 10 * 60 * 1000) {
    await env.EMBY_ICONS.delete(key);
    await restorePendingSubmission(settings, pending, "⏱️ 拒绝操作已超时，可重新审核。");
    await sendTelegramMessage(settings.token, settings.chatId, "拒绝操作已超时，请重新点击审核消息中的“拒绝”按钮。");
    return;
  }
  const reason = text.replace(/^\/reject(?:@[^\s]+)?/i, "").trim();
  if (reason.length > 1000) {
    await sendTelegramMessage(settings.token, settings.chatId, "拒绝原因不能超过 1000 个字符。");
    return;
  }
  const response = await executeAdminDecision(new Request("https://telegram-webhook.invalid"), env, pending.id, "reject", reason);
  const body = await response.json().catch(() => ({}));
  if (response.ok) {
    await env.EMBY_ICONS.delete(key);
    await sendTelegramMessage(settings.token, settings.chatId, `❌ 已拒绝提交\n编号：${pending.id}\n原因：${reason || "未填写拒绝原因"}`);
    if (pending.messageId) {
      await editTelegramSubmission(settings.token, { chat: { id: settings.chatId }, message_id: pending.messageId, text: pending.messageText || "Emby 图标提交" }, `❌ 已拒绝\n原因：${reason || "未填写拒绝原因"}`).catch(() => {});
    }
  } else {
    await sendTelegramMessage(settings.token, settings.chatId, `拒绝失败：${body.error || "无法处理该提交"}`);
  }
}

export async function handleTelegramWebhook(request, env, secretParam) {
  if (!env.EMBY_ICONS) return new Response("Not found", { status: 404 });
  let settings;
  try {
    settings = await readSettings(env);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (!settings.token || !settings.webhookSecret || secretParam !== settings.webhookSecret) return new Response("Not found", { status: 404 });
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== settings.webhookSecret) return new Response("Not found", { status: 404 });

  try {
    const update = await request.json();
    if (update.callback_query) await handleCallbackUpdate(request, env, settings, update.callback_query);
    else if (update.message) await handleMessageUpdate(env, settings, update.message);
  } catch (error) {
    await writeAuditLog(env, {
      actorId: "telegram",
      action: "telegram-webhook-failed",
      details: { error: String(error.message || "Webhook processing failed").slice(0, 240) },
    }).catch(() => {});
  }
  return new Response("ok", { status: 200 });
}

export function handleTelegramOptions(request) {
  return new Response(null, { status: 204, headers: responseHeaders(request) });
}
