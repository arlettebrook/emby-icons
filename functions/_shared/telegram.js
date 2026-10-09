import { hasAdminAccess } from "./admin.js";
import { findIconNameConflict, readDocument, suggestIconNames, writeAuditLog } from "./icons.js";

const SETTINGS_KEY = "settings/telegram.json";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_TOKEN_LENGTH = 256;
const MAX_CHAT_ID_LENGTH = 256;
const REVIEW_TIMEOUT_MS = 10 * 60 * 1000;
const REJECT_REASONS = ["图片模糊或质量不佳", "图标重复，无需收录", "图片无法访问"];
const TEXT_LIMIT = 4096;
const CAPTION_LIMIT = 1024;
const QUEUE_LIMIT = 50;
const QUEUE_PAGE_SIZE = 10;
const MAX_EDIT_NOTE_LENGTH = 1000;

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

// Same as sendTelegramMessage but for card bodies that already contain HTML.
async function sendHtmlMessage(token, chatId, text, replyMarkup) {
  return telegramApi(token, "sendMessage", {
    chat_id: chatId,
    text: hardTruncate(text, TEXT_LIMIT),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

// Cut already-escaped HTML without splitting a trailing entity or surrogate pair.
function hardTruncate(value, limit) {
  const text = String(value || "");
  if (text.length <= limit) return text;
  let cut = text.slice(0, Math.max(0, limit - 1)).replace(/&[a-zA-Z#0-9]*$/, "");
  cut = cut.replace(/[\uD800-\uDBFF]$/, "");
  return cut + "…";
}

function truncate(value, limit) {
  const text = String(value || "");
  if (text.length <= limit) return text;
  // Avoid splitting emoji/surrogate pairs at a truncation boundary.
  return text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, "") + "…";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>]/g, (character) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[character]
  ));
}

// Escape first, then cut, so HTML entities are never split in half.
function htmlTruncate(value, limit) {
  const escaped = escapeHtml(value);
  if (escaped.length <= limit) return escaped;
  const cut = escaped.slice(0, Math.max(0, limit - 1)).replace(/&[a-zA-Z#0-9]*$/, "");
  return `${cut}…`;
}

// Rebuild cards from submission data instead of appending to callback.message.text.
// Cards use Telegram HTML so names and status stand out; every field is escaped
// before it is truncated so the markup can never be broken by user content.
function submissionMessage(submission, status = "🕓 待审核", detail = "", limit = TEXT_LIMIT) {
  const compact = limit <= CAPTION_LIMIT;
  const name = htmlTruncate(submission.name, 140);
  const url = htmlTruncate(submission.url, compact ? 140 : 2048);
  const note = htmlTruncate(submission.note || "无", compact ? 120 : 600);
  const id = htmlTruncate(submission.id, 40);
  const statusLine = htmlTruncate(status, compact ? 200 : 800);
  let text = [
    "🖼 <b>Emby 图标审核</b>",
    `名称：<b>${name}</b>`,
    `URL：<code>${url}</code>`,
    `说明：${note}`,
    `编号：<code>${id}</code>`,
    "",
    `<b>${statusLine}</b>`,
  ].join("\n");
  const remaining = limit - text.length - 2;
  if (detail && remaining > 12) text += `\n\n${htmlTruncate(detail, remaining - 1)}`;
  return text;
}

function submissionKeyboard(submission) {
  const rows = [];
  if (submission?.url) rows.push([{ text: "🖼 打开原图", url: submission.url }]);
  rows.push([
    { text: "✅ 通过并发布", callback_data: `approve:${submission.id}` },
    { text: "❌ 拒绝…", callback_data: `reject:${submission.id}` },
  ]);
  rows.push([
    { text: "✏️ 改名并通过…", callback_data: `rename-manual:${submission.id}` },
    { text: "📝 编辑并发布…", callback_data: `edit:${submission.id}` },
  ]);
  return { inline_keyboard: rows };
}

function conflictStateKey(id) {
  return `settings/telegram/conflict/${id}`;
}

function conflictKeyboard(submission, suggestions) {
  const id = submission.id;
  const list = (Array.isArray(suggestions) ? suggestions : []).filter((name) => typeof name === "string" && name.trim());
  const rows = [];
  if (submission?.url) rows.push([{ text: "🖼 打开原图", url: submission.url }]);
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

// Oldest-first list of pending submissions, used by /queue and the "next" button.
async function listPendingSubmissions(env, limit = QUEUE_LIMIT) {
  if (!env.DB) return [];
  const result = await env.DB.prepare(
    "SELECT id, name, url, note, status, created_at FROM submissions WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?1",
  ).bind(limit).all();
  return result.results || [];
}

async function nextPendingSubmission(env, currentId) {
  let rows = [];
  try {
    rows = await listPendingSubmissions(env, QUEUE_LIMIT + 1);
  } catch {
    return null;
  }
  const queue = rows.filter((row) => row && row.id && row.id !== currentId);
  if (!queue.length) return null;
  return { id: queue[0].id, remaining: queue.length, capped: queue.length > QUEUE_LIMIT };
}

async function nextPendingKeyboard(env, currentId) {
  const next = await nextPendingSubmission(env, currentId);
  if (!next) return { inline_keyboard: [] };
  const suffix = next.remaining > 1 ? `（剩 ${next.remaining}${next.capped ? "+" : ""} 条）` : "";
  return { inline_keyboard: [[{ text: `⏭ 下一条待审核${suffix}`, callback_data: `view:${next.id}` }]] };
}

function waitLabel(createdAt) {
  const started = Number(createdAt);
  if (!Number.isFinite(started)) return "未知";
  const minutes = Math.max(0, Math.floor((Date.now() - started) / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

function queueMessage(rows) {
  if (!rows.length) return "📋 <b>待审核队列</b>\n\n🎉 当前没有待审核的提交。";
  const lines = [`📋 <b>待审核队列</b>（${rows.length} 条）`];
  rows.forEach((row, index) => {
    lines.push(`${index + 1}. <b>${htmlTruncate(row.name, 80)}</b> · 等待 ${waitLabel(row.created_at)}`);
    lines.push(`<code>${htmlTruncate(row.id, 40)}</code>`);
  });
  return lines.join("\n");
}

function queueKeyboard(rows) {
  return {
    inline_keyboard: rows.slice(0, QUEUE_PAGE_SIZE).map((row, index) => ([
      { text: `${index + 1}. 审核 ${truncate(row.name, 24)}`, callback_data: `view:${row.id}` },
    ])),
  };
}

// Parse the free-text "edit and publish" reply. Fields are order-independent and
// accept both half- and full-width colons; unknown lines extend the last field.
function parseEditInput(text) {
  const fields = {};
  let current = null;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(名称|名字|标题|URL|链接|地址|说明|描述)\s*[:：]\s*(.*)$/i.exec(line);
    if (!match) {
      if (current) fields[current] = `${fields[current]}\n${line}`;
      continue;
    }
    const label = match[1].toLowerCase();
    current = /^(名称|名字|标题)$/.test(label) ? "name"
      : /^(url|链接|地址)$/.test(label) ? "url" : "description";
    fields[current] = match[2].trim();
  }
  return fields;
}

// Toast text shown on the callback button. Distinct per action, and answered
// before any database or publication work begins.
function callbackToast(action) {
  switch (action) {
    case "approve": return "正在准备发布…";
    case "approve-confirm": return "正在发布，请稍候…";
    case "rename": return "正在改名并发布…";
    case "rename-manual": return "请回复新的图标名称…";
    case "edit": return "请回复修改后的名称、URL 和说明…";
    case "reject": return "请回复拒绝原因…";
    case "reject-preset": return "正在记录拒绝原因…";
    case "reject-empty": return "正在拒绝该提交…";
    case "replace": return "请确认是否替换…";
    case "replace-confirm": return "正在替换并发布…";
    case "cancel": return "已取消操作";
    case "view": return "正在打开下一条待审核…";
    default: return "正在处理…";
  }
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
  await postReviewCard(env, settings, submission, { withKeyboard: Boolean(settings.webhookSecret) });
  return true;
}

// Build a fresh review card message, including conflict handling. Shared by new
// submissions and the "next pending" jump so the buttons always match the state.
async function postReviewCard(env, settings, submission, { withKeyboard = true } = {}) {
  let status = "🕓 待审核";
  let detail = "";
  let keyboard = withKeyboard ? submissionKeyboard(submission) : null;
  const existing = await findSubmissionConflict(env, submission.name);
  if (existing) {
    const notice = conflictNotice(submission.name, { conflict: existing.conflict, suggestions: existing.suggestions });
    detail = notice.text;
    status = "⚠️ 待审核 · 名称冲突";
    if (withKeyboard && env.EMBY_ICONS) {
      await env.EMBY_ICONS.put(conflictStateKey(submission.id), JSON.stringify({
        id: submission.id, name: submission.name, suggestions: notice.suggestions, createdAt: Date.now(),
      }));
      keyboard = conflictKeyboard(submission, notice.suggestions);
    }
  }
  return sendCard(settings, submission, status, keyboard, detail);
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
    if (state?.id && state.messageId && state.userId && state.nonce && ["rename", "reject", "replace", "approve", "edit"].includes(state.action)) return state;
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
  return { chat: { id: settings.chatId }, message_id: state.messageId, cardKind: state.cardKind };
}

function cardKindOf(message) {
  if (message?.cardKind === "photo" || message?.cardKind === "text") return message.cardKind;
  if (Array.isArray(message?.photo)) return "photo";
  return "text";
}

async function editCard(settings, message, submission, status, keyboard = { inline_keyboard: [] }, detail = "") {
  if (!message?.message_id) return false;
  const kind = cardKindOf(message);
  const payload = kind === "photo"
    ? {
      chat_id: settings.chatId,
      message_id: message.message_id,
      caption: submissionMessage(submission, status, detail, CAPTION_LIMIT),
      parse_mode: "HTML",
      reply_markup: keyboard,
    }
    : {
      chat_id: settings.chatId,
      message_id: message.message_id,
      text: submissionMessage(submission, status, detail, TEXT_LIMIT),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: keyboard,
    };
  try {
    await telegramApi(settings.token, kind === "photo" ? "editMessageCaption" : "editMessageText", payload);
    return true;
  } catch (error) {
    // A duplicate webhook may redraw the same card. That is already success.
    if (/message is not modified/i.test(error.message)) return true;
    return false;
  }
}

// Prefer a photo card so the reviewer sees the icon, and fall back to a plain
// text card for URLs Telegram cannot render as a photo (SVG/ICO, unreachable...).
async function sendCard(settings, submission, status, keyboard, detail = "") {
  const markup = keyboard ? { reply_markup: keyboard } : {};
  try {
    const result = await telegramApi(settings.token, "sendPhoto", {
      chat_id: settings.chatId,
      photo: submission.url,
      caption: submissionMessage(submission, status, detail, CAPTION_LIMIT),
      parse_mode: "HTML",
      ...markup,
    });
    return { message_id: result.message_id, cardKind: "photo" };
  } catch {
    const result = await telegramApi(settings.token, "sendMessage", {
      chat_id: settings.chatId,
      text: submissionMessage(submission, status, detail, TEXT_LIMIT),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...markup,
    });
    return { message_id: result.message_id, cardKind: "text" };
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
    return editCard(settings, message, submission, "⚠️ 待审核 · 名称冲突", conflictKeyboard(submission, notice.suggestions), [detail, notice.text].filter(Boolean).join("\n"));
  }
  await env.EMBY_ICONS.delete(conflictStateKey(submission.id)).catch(() => {});
  return editCard(settings, message, submission, "🕓 待审核", submissionKeyboard(submission), detail);
}

async function retirePrompt(settings, state, text = "本次输入已结束，请使用审核卡片上的按钮继续。") {
  if (!state?.promptMessageId) return;
  // Delete the one-off input prompt so it does not linger after the reviewer
  // replies (for example with /reject) or cancels. Only fall back to a short,
  // keyboard-free note if Telegram refuses the deletion (e.g. message is old).
  try {
    await telegramApi(settings.token, "deleteMessage", {
      chat_id: settings.chatId,
      message_id: state.promptMessageId,
    });
  } catch {
    await telegramApi(settings.token, "editMessageText", {
      chat_id: settings.chatId,
      message_id: state.promptMessageId,
      text: `${text}\n编号：${state.id}`,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
  }
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

async function executeAdminDecision(request, env, id, action, payload = {}) {
  const { handleAdminSubmissionDecision } = await import("./submissions.js");
  return handleAdminSubmissionDecision(
    new Request(request.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
    }), env, id,
  );
}

function cancelButton(state) {
  return { text: "↩️ 取消，返回审核", callback_data: `cancel:${state.id}:${state.nonce}` };
}

function inputKeyboard(state) {
  const rows = [];
  if (state.action === "approve") {
    rows.push([{ text: "✅ 确认通过并发布", callback_data: `approve-confirm:${state.id}:${state.nonce}` }]);
  }
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
    : state.action === "edit"
      ? [
        `📝 请回复「${row.name}」的修改内容，每个字段一行：`,
        "名称：新名称",
        "URL：https://example.com/icon.png",
        "说明：可选（不写则保持原说明）",
        "10 分钟内有效 · 发送 /cancel 或点击卡片上的取消按钮",
      ].join("\n")
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
      input_field_placeholder: state.action === "rename"
        ? "新名称（发送后通过审核）"
        : state.action === "edit" ? "名称/URL/说明（多行）" : "输入拒绝原因",
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
    id: row.id, action, messageId: message.message_id, cardKind: cardKindOf(message),
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
  } else if (action === "approve") {
    status = "🛡️ 确认通过并发布？\n点击下方按钮后立即上线，避免误触；10 分钟内有效。";
  } else if (action === "edit") {
    status = "📝 等待编辑内容 · 回复下方提示后按修改后的信息直接发布";
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
  if (action !== "replace" && action !== "approve") {
    try {
      await sendInputPrompt(env, settings, key, state, row);
    } catch {
      await clearState(env, settings, key, state);
      await refreshCard(env, settings, message, row, "输入提示发送失败，请重新操作。");
    }
  }
}

async function finishDecision(request, env, settings, key, state, message, row, action, payload = {}) {
  const response = await executeAdminDecision(request, env, row.id, action, payload);
  const body = await response.json().catch(() => ({}));
  const latest = await readReviewSubmission(env, row.id);
  if (response.ok) {
    if (state?.id === row.id) await clearState(env, settings, key, state);
    await env.EMBY_ICONS.delete(conflictStateKey(row.id)).catch(() => {});
    const label = action === "replace" ? "♻️ 已替换现有图标并发布"
      : action === "approve-rename" ? `✅ 已改名为「${latest?.name || payload.name || row.name}」并通过`
        : action === "edit" ? `✅ 已编辑并发布：${latest?.name || payload.name || row.name}`
        : resolvedStatus(latest || row);
    // Offer the next pending submission so reviewers never scroll back.
    const keyboard = await nextPendingKeyboard(env, row.id);
    const edited = await editCard(settings, message, latest || row, label, keyboard);
    if (!edited) {
      // A completed decision must remain visible even if its original card was deleted.
      await sendHtmlMessage(settings.token, settings.chatId,
        submissionMessage(latest || row, label, "", TEXT_LIMIT), keyboard);
    }
    return;
  }
  if (latest && !["pending", "approving"].includes(latest.status)) {
    if (state?.id === row.id) await clearState(env, settings, key, state);
    await refreshCard(env, settings, message, latest);
    return;
  }
  if (body.code === "ICON_NAME_CONFLICT") {
    const notice = await saveConflict(env, row.id, payload.name || row.name, body);
    const keyboard = conflictKeyboard(latest || row, notice.suggestions);
    if (state?.id === row.id && ["rename", "edit"].includes(state.action)) {
      keyboard.inline_keyboard.push([cancelButton(state)]);
      await editCard(settings, message, latest || row, "⚠️ 名称冲突 · 可继续输入新名称", keyboard, notice.text);
      await sendInputPrompt(env, settings, key, state, latest || row, notice.text);
    } else {
      await editCard(settings, message, latest || row, "⚠️ 名称冲突", keyboard, notice.text);
    }
    return;
  }
  const errorText = `审核未完成：${truncate(body.error || "处理失败，请重试", 240)}`;
  if (state?.id === row.id && ["rename", "reject", "edit"].includes(state.action)) {
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
  const match = /^(approve|approve-confirm|reject|replace|rename-manual|rename|edit|cancel|view|reject-preset|reject-empty|replace-confirm):([0-9a-f-]{36})(?::([0-9a-f]{1,8}))?(?::([0-2]))?$/i.exec(String(callback.data || ""));
  if (!match) {
    await answerCallback(settings.token, callback.id, "无效的审核操作").catch(() => {});
    return;
  }
  const action = match[1].toLowerCase();
  // Stop Telegram's button spinner before any database/publication work, with
  // a toast that matches what the reviewer actually triggered.
  await answerCallback(settings.token, callback.id, callbackToast(action)).catch(() => {});
  const id = match[2];
  const key = reviewStateKey(chatId, userId);
  let state = await readReviewState(env, key);
  const row = await readReviewSubmission(env, id);
  if (!row) {
    if (state?.id === id) await clearState(env, settings, key, state);
    await editCard(settings, callback.message, { id }, resolvedStatus(null));
    return;
  }
  // Reuse the result card as the next review card so reviewers can keep working
  // down the queue without scrolling back to older messages.
  if (action === "view") {
    await postReviewCard(env, settings, row, { withKeyboard: true });
    return;
  }
  if (row.status !== "pending" && !(row.status === "approving" && action === "approve")) {
    if (state?.id === id) await clearState(env, settings, key, state);
    await refreshCard(env, settings, callback.message, row);
    return;
  }
  if (["cancel", "reject-preset", "reject-empty", "replace-confirm", "approve-confirm"].includes(action)) {
    const expectedAction = action.startsWith("reject-") ? "reject" : action === "approve-confirm" ? "approve" : "replace";
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
    if (action === "approve-confirm") {
      await finishDecision(request, env, settings, key, state, callback.message, row, "approve", {});
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
      await finishDecision(request, env, settings, key, state, callback.message, row, "replace", {});
      return;
    }
    if (action === "reject-preset" && match[4] === undefined) return;
    const reason = action === "reject-preset" ? REJECT_REASONS[Number(match[4])] : "";
    await finishDecision(request, env, settings, key, state, callback.message, row, "reject", { note: reason });
    return;
  }
  if (action === "approve") {
    // A fresh approval asks for an explicit confirmation click; an "approving"
    // retry (already confirmed) publishes straight away.
    if (row.status === "approving") {
      await finishDecision(request, env, settings, key, state, callback.message, row, "approve", {});
      return;
    }
    await beginInput(env, settings, key, state, callback.message, row, "approve", callback.from);
    return;
  }
  if (["reject", "rename-manual", "replace", "edit"].includes(action)) {
    await beginInput(env, settings, key, state, callback.message, row, action === "rename-manual" ? "rename" : action, callback.from);
    return;
  }
  if (action === "rename") {
    const name = await readSuggestedName(env, id, Number(match[3] || 0));
    if (!name) {
      await refreshCard(env, settings, callback.message, row, "改名建议已失效，已刷新可用操作。");
      return;
    }
    await finishDecision(request, env, settings, key, state, callback.message, row, "approve-rename", { name });
    return;
  }
  await refreshCard(env, settings, callback.message, row);
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
  const text = String(message.text || "").trim();
  // /queue is read-only and works whether or not a review input is pending.
  if (/^\/queue(?:@[^\s]+)?$/i.test(text)) {
    try {
      const rows = await listPendingSubmissions(env);
      await sendHtmlMessage(settings.token, settings.chatId, queueMessage(rows), queueKeyboard(rows));
    } catch {
      await sendTelegramMessage(settings.token, settings.chatId, "读取待审核队列失败，请稍后重试。");
    }
    return;
  }
  const state = await readReviewState(env, key);
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
  if (state.action === "approve") {
    await sendTelegramMessage(settings.token, settings.chatId, "请点击卡片上的「✅ 确认通过并发布」按钮完成发布，或发送 /cancel 取消。");
    return;
  }
  if (!text) {
    await sendInputPrompt(env, settings, key, state, row, "请发送文字内容，不支持图片、贴纸或附件。");
    return;
  }
  if (state.action === "edit") {
    const fields = parseEditInput(text);
    const name = String(fields.name || "").trim();
    const url = String(fields.url || "").trim();
    const description = String(fields.description || "").trim();
    if (!name || name.length > 120) {
      await sendInputPrompt(env, settings, key, state, row, "名称需为 1-120 个字符，请按“名称：/URL：/说明：”重新回复。");
      return;
    }
    if (!url || url.length > 2048) {
      await sendInputPrompt(env, settings, key, state, row, "URL 必填且不超过 2048 个字符，请按格式重新回复。");
      return;
    }
    if (description.length > 1000) {
      await sendInputPrompt(env, settings, key, state, row, "说明不能超过 1000 个字符，请重新回复。");
      return;
    }
    await finishDecision(new Request("https://telegram-webhook.invalid"), env, settings, key, state,
      stateMessage(settings, state), row, "edit",
      fields.description === undefined ? { name, url } : { name, url, description });
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
    state.action === "reject" ? { note: value } : { name: value });
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
