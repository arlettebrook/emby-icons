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

  const record = {
    version: 1,
    enabled,
    chatId,
    token: token ? await encryptToken(token, env) : null,
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
  return jsonResponse(request, publicSettings({ enabled, chatId, token }));
}

export async function notifyNewSubmission(env, submission) {
  const settings = await readSettings(env);
  if (!settings.enabled || !settings.token || !settings.chatId) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(settings.token)}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: settings.chatId,
        text: [
          "🔔 新的 Emby 图标提交",
          `名称：${submission.name}`,
          `URL：${submission.url}`,
          `说明：${submission.note || "无"}`,
          `编号：${submission.id}`,
          "请登录管理页面进行审核。",
        ].join("\n"),
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok !== true) throw new Error(body.description || `Telegram request failed (${response.status})`);
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

export async function queueSubmissionNotification(env, submission, waitUntil) {
  const task = notifyNewSubmission(env, submission).catch(async (error) => {
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

export function handleTelegramOptions(request) {
  return new Response(null, { status: 204, headers: responseHeaders(request) });
}
