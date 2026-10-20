import {
  STORAGE_KEY,
  buildIconNameConflict,
  createEtag,
  findIconNameConflict,
  normalizeIconName,
  readDocument,
  saveDocumentSnapshot,
  suggestIconNames,
  writeAuditLog,
} from "./icons.js";
import { hasAdminAccess } from "./admin.js";
import {
  clearSubmissionConflictState,
  notifySubmissionResult,
  queueSubmissionNotification,
  verifyTelegramInitData,
} from "./telegram.js";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_NAME_LENGTH = 120;
const MAX_URL_LENGTH = 2048;
const MAX_NOTE_LENGTH = 1000;
const DEFAULT_SUBMISSIONS_PER_IP_PER_DAY = 20;
const ALLOWED_SUBMISSION_SOURCES = new Set(["channel8", "menu", "command"]);
const NON_IMAGE_EXTENSIONS = new Set([
  ".7z", ".apk", ".avi", ".bin", ".csv", ".dmg", ".doc", ".docx", ".exe",
  ".gz", ".htm", ".html", ".iso", ".json", ".m4a", ".mkv", ".mov", ".mp3",
  ".mp4", ".pdf", ".ppt", ".pptx", ".rar", ".tar", ".txt", ".wav", ".xls",
  ".xlsx", ".xml", ".zip",
]);

function corsHeaders(request, env) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, If-Match, X-Submission-Token, X-Telegram-Init-Data, X-Turnstile-Token",
    "Access-Control-Expose-Headers": "ETag",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
  const origin = request.headers.get("Origin");
  const allowedOrigin = new URL(request.url).origin;
  if (origin && origin === allowedOrigin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function jsonResponse(request, env, body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  Object.entries(corsHeaders(request, env)).forEach(([name, value]) => headers.set(name, value));
  return new Response(JSON.stringify(body), { ...init, headers });
}

function requireDatabase(request, env) {
  if (env.DB) return null;
  return jsonResponse(request, env, { error: "DB binding is not configured" }, { status: 503 });
}

function getIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

function getDailySubmissionLimit(env) {
  const configured = Number(env.SUBMISSION_DAILY_LIMIT || DEFAULT_SUBMISSIONS_PER_IP_PER_DAY);
  if (!Number.isFinite(configured)) return DEFAULT_SUBMISSIONS_PER_IP_PER_DAY;
  return Math.min(Math.max(Math.floor(configured), 1), 100);
}

function getSubmissionHashSecret(env) {
  return String(env.SUBMISSION_HASH_SECRET || "").trim();
}

function requireSubmissionHashSecret(request, env) {
  if (getSubmissionHashSecret(env)) return null;
  return jsonResponse(request, env, { error: "SUBMISSION_HASH_SECRET is not configured" }, { status: 503 });
}

async function hashValue(value, env) {
  const secret = getSubmissionHashSecret(env);
  if (!secret) throw new Error("SUBMISSION_HASH_SECRET is not configured");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function trimString(value, field, maxLength, required = true) {
  if (typeof value !== "string") return `${field} must be a string`;
  const normalized = value.trim();
  if (required && !normalized) return `${field} is required`;
  if (normalized.length > maxLength) return `${field} is too long`;
  return normalized;
}

function validateSubmission(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "Request body must be an object" };

  const name = trimString(value.name, "name", MAX_NAME_LENGTH);
  if (typeof name !== "string") return { error: name };

  const urlText = trimString(value.url, "url", MAX_URL_LENGTH);
  if (typeof urlText !== "string") return { error: urlText };
  let url;
  try {
    url = new URL(urlText);
  } catch {
    return { error: "url must be a valid URL" };
  }
  if (url.protocol !== "https:") return { error: "url must use HTTPS" };
  if (url.username || url.password) return { error: "url must not contain credentials" };
  const extension = url.pathname.toLowerCase().match(/\.[a-z0-9]{1,10}$/)?.[0] || "";
  if (NON_IMAGE_EXTENSIONS.has(extension)) {
    return { error: "url must point to an image, not a document or archive" };
  }

  const note = value.note === undefined ? "" : trimString(value.note, "note", MAX_NOTE_LENGTH, false);
  if (typeof note !== "string") return { error: note };
  return { value: { name, url: url.href, note } };
}

function normalizeSubmissionSource(value) {
  const source = typeof value === "string" ? value.trim().toLowerCase().slice(0, 64) : "";
  return ALLOWED_SUBMISSION_SOURCES.has(source) ? source : "direct";
}

async function readJson(request, env) {
  const declaredSize = Number(request.headers.get("Content-Length") || 0);
  if (declaredSize > MAX_BODY_BYTES) throw new Error("Request body is too large");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) throw new Error("Request body is too large");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Request body is not valid JSON");
  }
}

function isProductionEnvironment(env) {
  const environment = String(env.ENVIRONMENT || "").trim().toLowerCase();
  const branch = String(env.CF_PAGES_BRANCH || "").trim().toLowerCase();
  return ["production", "prod"].includes(environment) || ["master", "main"].includes(branch);
}

async function verifyTurnstile(request, env, body) {
  const secret = String(env.TURNSTILE_SECRET_KEY || "").trim();
  if (!secret) {
    // Production must never silently accept submissions without Turnstile.
    if (isProductionEnvironment(env) || String(env.REQUIRE_TURNSTILE).toLowerCase() === "true") {
      return "Turnstile is not configured";
    }
    return null;
  }
  const token = String(body.turnstileToken || request.headers.get("X-Turnstile-Token") || "").trim();
  if (!token) return "Turnstile verification is required";

  const form = new URLSearchParams({ secret, response: token });
  const ip = getIp(request);
  if (ip !== "unknown") form.set("remoteip", ip);
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!response.ok) return "Turnstile verification failed";
    const result = await response.json();
    return result.success ? null : "Turnstile verification failed";
  } catch {
    return "Turnstile verification failed";
  }
}

async function readSubmission(env, id) {
  return env.DB.prepare(
    `SELECT id, name, url, note, status, submitter_token_hash, ip_hash, created_at,
            reviewer_id, reviewer_note, reviewed_at,
            telegram_user_id, telegram_username, result_notified_at, source, normalized_name
       FROM submissions WHERE id = ?1`,
  )
    .bind(id)
    .first();
}

function publicSubmission(row) {
  if (!row) return null;
  const {
    submitter_token_hash: _token,
    ip_hash: _ip,
    telegram_user_id: _telegramUserId,
    telegram_username: _telegramUsername,
    result_notified_at: _resultNotifiedAt,
    ...safe
  } = row;
  return safe;
}

function telegramInitData(request) {
  return String(request.headers.get("X-Telegram-Init-Data") || "").trim();
}

// Reads the optional Telegram identity supplied by the Mini App. A malformed
// or forged payload is reported as "provided but invalid" so the caller can
// reject it instead of silently downgrading to an anonymous request.
async function readTelegramIdentity(request, env) {
  const raw = telegramInitData(request);
  if (!raw) return { provided: false, identity: null };
  return { provided: true, identity: await verifyTelegramInitData(env, raw) };
}

async function requireSubmissionOwner(request, env, id) {
  const token = String(request.headers.get("X-Submission-Token") || "").trim();
  const telegram = await readTelegramIdentity(request, env);
  // Once a client supplies initData, a bad signature or expired payload must
  // fail closed even when an access token is also present. The token may still
  // be used from an ordinary browser, but it must not turn forged identity data
  // into a silent anonymous fallback.
  if (telegram.provided && !telegram.identity) {
    return {
      response: jsonResponse(request, env, {
        error: "Telegram 身份校验失败，请重新打开 Mini App。",
        code: "TELEGRAM_AUTH_INVALID",
      }, { status: 401 }),
    };
  }
  if (!token && !telegram.identity) {
    return {
      response: jsonResponse(request, env, { error: "Submission token or Telegram identity is required" }, { status: 401 }),
    };
  }
  const row = await readSubmission(env, id);
  if (!row) return { response: jsonResponse(request, env, { error: "Submission not found" }, { status: 404 }) };

  if (token) {
    const tokenHash = await hashValue(token, env);
    if (tokenHash === row.submitter_token_hash) return { row };
  }

  if (telegram.identity && row.telegram_user_id && String(row.telegram_user_id) === String(telegram.identity.id)) {
    return { row };
  }

  if (token) {
    return { response: jsonResponse(request, env, { error: "Invalid submission token" }, { status: 403 }) };
  }
  return { response: jsonResponse(request, env, { error: "这条提交不属于当前 Telegram 账号。" }, { status: 403 }) };
}

async function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return jsonResponse(request, env, { error: "ADMIN_TOKEN is not configured" }, { status: 503 });
  if (!(await hasAdminAccess(request, env))) {
    return jsonResponse(request, env, { error: "Invalid admin session" }, { status: 401 });
  }
  return null;
}

export async function acquirePublicationLock(env, owner) {
  const now = Date.now();
  const expiresAt = now + 30_000;
  await env.DB.prepare(
    `INSERT INTO document_publish_lock (lock_name, owner, expires_at)
     VALUES ('canonical', ?1, ?2)
     ON CONFLICT(lock_name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
     WHERE document_publish_lock.expires_at < ?3`,
  )
    .bind(owner, expiresAt, now)
    .run();
  const lock = await env.DB.prepare("SELECT owner FROM document_publish_lock WHERE lock_name = 'canonical'").first();
  return lock?.owner === owner;
}

export async function releasePublicationLock(env, owner) {
  await env.DB.prepare("DELETE FROM document_publish_lock WHERE lock_name = 'canonical' AND owner = ?1").bind(owner).run();
}

async function resetToPending(env, id) {
  try {
    await env.DB
      .prepare("UPDATE submissions SET status = 'pending' WHERE id = ?1 AND status = 'approving'")
      .bind(id)
      .run();
  } catch {
    // Best-effort rollback; the publication lock TTL will recover the row.
  }
}

async function finalizeApproval(env, id, reviewerId, name, fields = {}) {
  // COALESCE keeps the stored url/note unless an edit explicitly overrides them.
  const updated = await env.DB
    .prepare(
      "UPDATE submissions SET status = 'approved', name = ?1, normalized_name = ?2, url = COALESCE(?3, url), note = COALESCE(?4, note), reviewer_id = ?5, reviewed_at = ?6 WHERE id = ?7 AND status IN ('approving', 'pending')",
    )
    .bind(
      name,
      normalizeIconName(name),
      fields.url === undefined ? null : fields.url,
      fields.note === undefined ? null : fields.note,
      reviewerId,
      Date.now(),
      id,
    )
    .run();

  if (updated.meta?.changes) return true;
  const latest = await readSubmission(env, id);
  if (latest?.status === "approved") return true;
  throw new Error("Submission state changed while publishing");
}

async function consumeSubmissionAttempt(request, env) {
  const ipHash = await hashValue(getIp(request), env);
  const now = Date.now();
  const cutoff = now - 24 * 60 * 60 * 1000;
  const limit = getDailySubmissionLimit(env);
  // Count and insert in one statement so concurrent requests cannot all pass
  // the check. Attempt rows are never deleted with a submission, so withdraw
  // and delete cannot restore a user's daily quota.
  const attempt = await env.DB.prepare(
    `INSERT INTO submission_attempts (ip_hash, created_at)
     SELECT ?1, ?2
      WHERE (SELECT COUNT(*) FROM submission_attempts WHERE ip_hash = ?1 AND created_at >= ?3) < ?4`,
  )
    .bind(ipHash, now, cutoff, limit)
    .run();
  if (!attempt.meta?.changes) {
    return {
      response: jsonResponse(request, env, { error: "今日提交次数已达上限，请稍后再试。", limit }, {
        status: 429,
        headers: { "Retry-After": "86400" },
      }),
    };
  }
  return { ipHash };
}

export async function handleSubmissionCreate(request, env, waitUntil) {
  const missingDb = requireDatabase(request, env);
  if (missingDb) return missingDb;
  const missingSecret = requireSubmissionHashSecret(request, env);
  if (missingSecret) return missingSecret;

  let body;
  try {
    body = await readJson(request, env);
  } catch (error) {
    return jsonResponse(request, env, { error: error.message }, { status: 400 });
  }

  // Telegram identity is optional so ordinary browsers can still submit
  // anonymously. If the Mini App did send initData, however, a forged or
  // expired payload must fail closed instead of silently becoming anonymous.
  const telegram = await readTelegramIdentity(request, env);
  if (telegram.provided && !telegram.identity) {
    return jsonResponse(request, env, {
      error: "Telegram 身份校验失败，请从机器人重新打开 Mini App 后再提交。",
      code: "TELEGRAM_AUTH_INVALID",
    }, { status: 401 });
  }
  const identity = telegram.identity;
  const telegramUsername = identity?.username ? String(identity.username).slice(0, 64) : null;

  const turnstileError = await verifyTurnstile(request, env, body);
  if (turnstileError) return jsonResponse(request, env, { error: turnstileError }, { status: 403 });

  const validation = validateSubmission(body);
  if (validation.error) return jsonResponse(request, env, { error: validation.error }, { status: 400 });

  const attempt = await consumeSubmissionAttempt(request, env);
  if (attempt.response) return attempt.response;
  const { ipHash } = attempt;

  const id = crypto.randomUUID();
  const accessToken = createToken();
  const tokenHash = await hashValue(accessToken, env);
  const now = Date.now();
  const source = normalizeSubmissionSource(body.startapp);
  await env.DB.prepare(
    `INSERT INTO submissions
      (id, name, url, note, status, submitter_token_hash, ip_hash, created_at,
       telegram_user_id, telegram_username, source, normalized_name)
     VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  )
    .bind(
      id,
      validation.value.name,
      validation.value.url,
      validation.value.note,
      tokenHash,
      ipHash,
      now,
      identity?.id || null,
      telegramUsername,
      source,
      normalizeIconName(validation.value.name),
    )
    .run();

  await writeAuditLog(env, {
    actorId: `submission:${id}`,
    action: "submission-created",
    targetId: id,
    details: {
      name: validation.value.name,
      url: validation.value.url,
      source,
      telegramBound: Boolean(identity),
    },
  });
  await queueSubmissionNotification(env, {
    id,
    name: validation.value.name,
    url: validation.value.url,
    note: validation.value.note,
  }, waitUntil, new URL(request.url).origin);

  return jsonResponse(
    request,
    env,
    {
      ok: true,
      submission: { id, status: "pending", name: validation.value.name, url: validation.value.url, source },
      accessToken,
      telegramBound: Boolean(identity),
    },
    { status: 201 },
  );
}

export async function handleSubmissionItem(request, env, id, waitUntil) {
  const missingDb = requireDatabase(request, env);
  if (missingDb) return missingDb;
  const missingSecret = requireSubmissionHashSecret(request, env);
  if (missingSecret) return missingSecret;
  const ownership = await requireSubmissionOwner(request, env, id);
  if (ownership.response) return ownership.response;
  const { row } = ownership;

  if (request.method === "GET") return jsonResponse(request, env, { submission: publicSubmission(row) });

  if (request.method === "DELETE") {
    // A record that is mid-publication must not vanish under the reviewer's feet.
    if (row.status === "approving") {
      return jsonResponse(request, env, { error: "该提交正在发布中，请稍后再删除" }, { status: 409 });
    }
    await env.DB.prepare("DELETE FROM submissions WHERE id = ?1").bind(id).run();
    await writeAuditLog(env, {
      actorId: `submission:${id}`,
      action: "submission-deleted",
      targetId: id,
      details: { name: row.name, status: row.status },
    });
    await clearSubmissionConflictState(env, id);
    return jsonResponse(request, env, { ok: true, deleted: true });
  }

  if (request.method === "POST") {
    if (row.status !== "pending") return jsonResponse(request, env, { error: "Only pending submissions can be withdrawn" }, { status: 409 });
    await env.DB.prepare("UPDATE submissions SET status = 'withdrawn' WHERE id = ?1 AND status = 'pending'").bind(id).run();
    await writeAuditLog(env, { actorId: `submission:${id}`, action: "submission-withdrawn", targetId: id });
    return jsonResponse(request, env, { ok: true, status: "withdrawn" });
  }

  if (request.method !== "PATCH") return jsonResponse(request, env, { error: "Method not allowed" }, { status: 405 });

  let body;
  try {
    body = await readJson(request, env);
  } catch (error) {
    return jsonResponse(request, env, { error: error.message }, { status: 400 });
  }
  const validation = validateSubmission(body);
  if (validation.error) return jsonResponse(request, env, { error: validation.error }, { status: 400 });

  if (row.status === "pending") {
    // 待审核的修改同样会改到公开队列里的内容，和重新提交一样要过 Turnstile：
    // 访问令牌只能证明「这条记录是你的」，挡不住拿着真实令牌的批量脚本。
    const turnstileError = await verifyTurnstile(request, env, body);
    if (turnstileError) return jsonResponse(request, env, { error: turnstileError }, { status: 403 });
    await env.DB.prepare("UPDATE submissions SET name = ?1, normalized_name = ?2, url = ?3, note = ?4 WHERE id = ?5 AND status = 'pending'")
      .bind(validation.value.name, normalizeIconName(validation.value.name), validation.value.url, validation.value.note, id)
      .run();
    await writeAuditLog(env, { actorId: `submission:${id}`, action: "submission-updated", targetId: id, details: validation.value });
    return jsonResponse(request, env, { ok: true, submission: { ...publicSubmission(row), ...validation.value } });
  }

  // 重新提交：被拒绝或已撤回的记录，允许改好名称/链接/说明后重新进入待审核队列。
  const resubmit = body?.resubmit === true;
  if (!resubmit || (row.status !== "rejected" && row.status !== "withdrawn")) {
    return jsonResponse(request, env, { error: "Only pending submissions can be edited" }, { status: 409 });
  }
  // 重新提交会重新进入公共审核队列，所以和首次提交一样要过 Turnstile；
  // 撤回、删除只改自己这一条的状态，沿用访问令牌，不额外要求验证。
  const turnstileError = await verifyTurnstile(request, env, body);
  if (turnstileError) return jsonResponse(request, env, { error: turnstileError }, { status: 403 });

  const attempt = await consumeSubmissionAttempt(request, env);
  if (attempt.response) return attempt.response;

  const reset = await env.DB
    .prepare(
      "UPDATE submissions SET name = ?1, normalized_name = ?2, url = ?3, note = ?4, status = 'pending', reviewer_id = NULL, reviewer_note = NULL, reviewed_at = NULL, result_notified_at = NULL WHERE id = ?5 AND status IN ('rejected', 'withdrawn')",
    )
    .bind(validation.value.name, normalizeIconName(validation.value.name), validation.value.url, validation.value.note, id)
    .run();
  if (!reset.meta?.changes) {
    const latest = await readSubmission(env, id);
    if (!latest || latest.status !== "pending") {
      return jsonResponse(request, env, { error: "提交状态已变化，请刷新后重试" }, { status: 409 });
    }
  }
  await writeAuditLog(env, { actorId: `submission:${id}`, action: "submission-resubmitted", targetId: id, details: validation.value });
  // 重新排队后要让审核人再次看到卡片，否则记录会静默地回到队列里。
  await queueSubmissionNotification(
    env,
    { id, name: validation.value.name, url: validation.value.url, note: validation.value.note },
    waitUntil,
    new URL(request.url).origin,
  );
  return jsonResponse(request, env, {
    ok: true,
    resubmitted: true,
    submission: {
      ...publicSubmission(row),
      ...validation.value,
      status: "pending",
      reviewer_id: null,
      reviewer_note: null,
      reviewed_at: null,
    },
  });
}

// Return only the current Telegram user's own records. The bot-signed initData
// is the authorization boundary; no submission access token is needed here.
export async function handleMySubmissionList(request, env) {
  const missingDb = requireDatabase(request, env);
  if (missingDb) return missingDb;
  if (request.method !== "GET") {
    return jsonResponse(request, env, { error: "Method not allowed" }, { status: 405 });
  }

  const telegram = await readTelegramIdentity(request, env);
  if (!telegram.provided) {
    return jsonResponse(request, env, { error: "Telegram identity is required" }, { status: 401 });
  }
  if (!telegram.identity) {
    return jsonResponse(request, env, {
      error: "Telegram 身份校验失败，请从机器人重新打开 Mini App。",
      code: "TELEGRAM_AUTH_INVALID",
    }, { status: 401 });
  }

  const rows = await env.DB.prepare(
    `SELECT id, name, url, note, status, reviewer_note, created_at, reviewed_at
       FROM submissions
      WHERE telegram_user_id = ?1
      ORDER BY created_at DESC
      LIMIT ?2`,
  )
    .bind(telegram.identity.id, 100)
    .all();
  return jsonResponse(request, env, { submissions: rows.results || [] });
}

const ADMIN_LIST_STATUSES = new Set(["pending", "approving", "approved", "rejected", "withdrawn", "all"]);

function encodeSubmissionCursor(row) {
  const payload = JSON.stringify({ createdAt: Number(row.created_at), id: String(row.id) });
  return btoa(payload).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeSubmissionCursor(value) {
  if (!value) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/")
      + "=".repeat((4 - (value.length % 4)) % 4);
    const parsed = JSON.parse(atob(padded));
    const createdAt = Number(parsed?.createdAt);
    const id = String(parsed?.id || "");
    if (!Number.isSafeInteger(createdAt) || createdAt < 0 || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export async function handleAdminSubmissionList(request, env) {
  const missingDb = requireDatabase(request, env);
  if (missingDb) return missingDb;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "pending";
  if (!ADMIN_LIST_STATUSES.has(status)) {
    return jsonResponse(request, env, { error: "Invalid status" }, { status: 400 });
  }
  const requestedLimit = Number(url.searchParams.get("limit") || 50);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100)
    : 50;
  const q = String(url.searchParams.get("q") || "").trim().slice(0, 200);
  const reviewerId = String(url.searchParams.get("reviewerId") || "").trim().slice(0, 128);
  const cursorParam = url.searchParams.get("cursor") || "";
  const cursor = decodeSubmissionCursor(cursorParam);
  if (cursorParam && !cursor) {
    return jsonResponse(request, env, { error: "Invalid cursor" }, { status: 400 });
  }

  // One stable query shape keeps pagination deterministic even when the name,
  // URL or reviewer filters change. The extra row tells us whether a next page
  // exists without a second COUNT query.
  const result = await env.DB.prepare(
    `SELECT id, name, url, note, status, source, created_at, reviewer_id,
            reviewer_note, reviewed_at
       FROM submissions
      WHERE (?1 = 'all' OR status = ?1)
        AND (?2 = '' OR name LIKE ?3 COLLATE NOCASE OR url LIKE ?3 COLLATE NOCASE)
        AND (?4 = '' OR reviewer_id = ?4)
        AND (?5 = 0 OR created_at < ?6 OR (created_at = ?6 AND id < ?7))
      ORDER BY created_at DESC, id DESC
      LIMIT ?8`,
  )
    .bind(
      status,
      q,
      `%${q}%`,
      reviewerId,
      cursor ? 1 : 0,
      cursor?.createdAt || 0,
      cursor?.id || "",
      limit + 1,
    )
    .all();
  const rawRows = Array.isArray(result.results) ? result.results : [];
  const hasMore = rawRows.length > limit;
  const rows = rawRows.slice(0, limit);
  const nextCursor = hasMore && rows.length ? encodeSubmissionCursor(rows[rows.length - 1]) : null;

  const statsResult = await env.DB.prepare(
    `SELECT status, source, reviewer_id, COUNT(*) AS count
       FROM submissions
      GROUP BY status, source, reviewer_id`,
  ).all();
  const stats = {
    pending: 0,
    approving: 0,
    total: 0,
    byStatus: {},
    bySource: {},
    byReviewer: {},
  };
  for (const stat of statsResult.results || []) {
    const count = Number(stat.count || 0);
    const statStatus = String(stat.status || "unknown");
    const source = String(stat.source || "direct");
    const reviewer = String(stat.reviewer_id || "unreviewed");
    stats.total += count;
    stats.byStatus[statStatus] = (stats.byStatus[statStatus] || 0) + count;
    stats.bySource[source] = (stats.bySource[source] || 0) + count;
    stats.byReviewer[reviewer] = (stats.byReviewer[reviewer] || 0) + count;
  }
  stats.pending = stats.byStatus.pending || 0;
  stats.approving = stats.byStatus.approving || 0;

  // Pre-check the pending queue against the published document so reviewers see
  // name conflicts before they try to approve. A broken/unavailable KV must not
  // take down the whole review queue.
  let icons = null;
  if (env.EMBY_ICONS && rows.some((row) => row.status === "pending")) {
    try {
      const current = await readDocument(env);
      if (current.text !== null) {
        const document = JSON.parse(current.text);
        if (Array.isArray(document?.icons)) icons = document.icons;
      }
    } catch {
      icons = null;
    }
  }

  const submissions = icons
    ? rows.map((row) => {
        const conflict = findIconNameConflict(icons, row.name);
        if (!conflict) return { ...row, conflict: null };
        return {
          ...row,
          conflict: {
            index: conflict.index,
            name: conflict.name,
            url: conflict.url,
            sameUrl: conflict.url === row.url,
          },
          suggestions: suggestIconNames(row.name, icons, 2),
        };
      })
    : rows;

  return jsonResponse(request, env, { submissions, nextCursor, stats });
}
async function notifySubmissionResultBestEffort(env, id, waitUntil) {
  const task = (async () => {
    try {
      await notifySubmissionResult(env, id);
    } catch {
      // A notification is a side effect. It must never turn a completed review
      // into a failed request or trigger a retry that republishes the icon.
    }
  })();
  if (typeof waitUntil === "function") waitUntil(task);
  else await task;
}

export async function handleAdminSubmissionDecision(request, env, id, waitUntil) {
  const missingDb = requireDatabase(request, env);
  if (missingDb) return missingDb;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;
  const row = await readSubmission(env, id);
  if (!row) return jsonResponse(request, env, { error: "Submission not found" }, { status: 404 });

  let body = {};
  try {
    body = await readJson(request, env);
  } catch (error) {
    return jsonResponse(request, env, { error: error.message }, { status: 400 });
  }

  const action = body.action;
  if (!["approve", "approve-rename", "replace", "edit", "reject"].includes(action)) {
    return jsonResponse(request, env, { error: "action must be approve, approve-rename, replace, edit or reject" }, { status: 400 });
  }

  const reviewerId = "admin";
  const note = body.note === undefined ? "" : trimString(body.note, "note", MAX_NOTE_LENGTH, false);
  if (typeof note !== "string") return jsonResponse(request, env, { error: note }, { status: 400 });

  if (action === "reject") {
    if (row.status !== "pending") return jsonResponse(request, env, { error: "Only pending submissions can be reviewed" }, { status: 409 });
    await env.DB.prepare(
      "UPDATE submissions SET status = 'rejected', reviewer_id = ?1, reviewer_note = ?2, reviewed_at = ?3 WHERE id = ?4 AND status = 'pending'",
    )
      .bind(reviewerId, note, Date.now(), id)
      .run();
    await writeAuditLog(env, { actorId: reviewerId, action: "submission-rejected", targetId: id, details: { note } });
    await notifySubmissionResultBestEffort(env, id, waitUntil);
    return jsonResponse(request, env, { ok: true, status: "rejected" });
  }

  if (row.status === "rejected" || row.status === "withdrawn") {
    return jsonResponse(request, env, { error: "Only pending submissions can be reviewed" }, { status: 409 });
  }
  if (row.status === "approved") {
    await notifySubmissionResultBestEffort(env, id, waitUntil);
    return jsonResponse(request, env, { ok: true, status: "approved", alreadyPublished: true });
  }

  let effectiveName = row.name;
  if (action === "approve-rename" || action === "edit") {
    const nameResult = trimString(body.name, "name", MAX_NAME_LENGTH);
    if (typeof nameResult !== "string") return jsonResponse(request, env, { error: nameResult }, { status: 400 });
    effectiveName = nameResult;
  }

  // "edit" lets a reviewer fix the name, image URL and description in one pass
  // before publishing. The description is kept separate from the review note.
  let effectiveUrl = row.url;
  let effectiveNote;
  if (action === "edit") {
    const urlResult = trimString(body.url, "url", MAX_URL_LENGTH);
    if (typeof urlResult !== "string") return jsonResponse(request, env, { error: urlResult }, { status: 400 });
    let parsedUrl;
    try {
      parsedUrl = new URL(urlResult);
    } catch {
      return jsonResponse(request, env, { error: "url must be a valid URL" }, { status: 400 });
    }
    if (parsedUrl.protocol !== "https:") return jsonResponse(request, env, { error: "url must use HTTPS" }, { status: 400 });
    if (parsedUrl.username || parsedUrl.password) return jsonResponse(request, env, { error: "url must not contain credentials" }, { status: 400 });
    effectiveUrl = parsedUrl.href;
    if (body.description !== undefined) {
      const description = trimString(body.description, "description", MAX_NOTE_LENGTH, false);
      if (typeof description !== "string") return jsonResponse(request, env, { error: description }, { status: 400 });
      effectiveNote = description;
    }
  }

  const editFields = action === "edit" ? { url: effectiveUrl, note: effectiveNote } : {};

  if (row.status === "pending") {
    const claimed = await env.DB.prepare("UPDATE submissions SET status = 'approving' WHERE id = ?1 AND status = 'pending'").bind(id).run();
    if (!claimed.meta?.changes) return jsonResponse(request, env, { error: "Submission is already being reviewed" }, { status: 409 });
  }

  const lockOwner = `submission:${id}:${crypto.randomUUID()}`;
  let lockAcquired = false;
  try {
    lockAcquired = await acquirePublicationLock(env, lockOwner);
  } catch (error) {
    await resetToPending(env, id);
    return jsonResponse(request, env, { error: error.message || "Publication lock is unavailable" }, { status: 503 });
  }
  if (!lockAcquired) {
    if (row.status === "pending") await resetToPending(env, id);
    return jsonResponse(request, env, { error: "Another publication is in progress; try again" }, { status: 409 });
  }

  let published = false;
  let publishedCount = null;
  try {
    if (!env.EMBY_ICONS) throw new Error("EMBY_ICONS KV is not configured");
    const current = await readDocument(env);
    const document = current.text === null
      ? { name: "Emby Icons", description: "", icons: [] }
      : JSON.parse(current.text);
    if (!document || typeof document !== "object" || Array.isArray(document) || !Array.isArray(document.icons)) {
      throw new Error("Published icon document is invalid");
    }

    const conflict = findIconNameConflict(document.icons, effectiveName);

    // Idempotent retry: a previous attempt may have written KV but failed before
    // updating D1. Matching name + URL means the submission is already published.
    if (conflict && conflict.url === effectiveUrl) {
      await finalizeApproval(env, id, reviewerId, conflict.name, editFields);
      await writeAuditLog(env, {
        actorId: reviewerId,
        action: "submission-approved",
        targetId: id,
        details: { name: conflict.name, url: conflict.url, alreadyPublished: true },
      });
      await notifySubmissionResultBestEffort(env, id, waitUntil);
      return jsonResponse(request, env, { ok: true, status: "approved", alreadyPublished: true, count: document.icons.length });
    }

    if (conflict && action !== "replace") {
      await resetToPending(env, id);
      return jsonResponse(
        request,
        env,
        buildIconNameConflict({ name: effectiveName, conflict, icons: document.icons, count: 2 }),
        { status: 409 },
      );
    }

    if (conflict) {
      const key = normalizeIconName(effectiveName);
      const replaced = document.icons.map((icon, index) =>
        index === conflict.index ? { ...icon, name: effectiveName, url: effectiveUrl } : icon,
      );
      document.icons = replaced.filter((icon, index) => index === conflict.index || normalizeIconName(icon?.name) !== key);
    } else {
      document.icons.push({ name: effectiveName, url: effectiveUrl });
    }

    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    const serializedEtag = await createEtag(serialized);
    await saveDocumentSnapshot(env, current.text, reviewerId, `approve-submission:${id}`);
    await env.EMBY_ICONS.put(STORAGE_KEY, serialized);
    published = true;
    publishedCount = document.icons.length;

    await finalizeApproval(env, id, reviewerId, effectiveName, editFields);
    await writeAuditLog(env, {
      actorId: reviewerId,
      action: "submission-approved",
      targetId: id,
      details: {
        name: effectiveName,
        url: effectiveUrl,
        etag: serializedEtag,
        ...(conflict ? { replaced: { name: conflict.name, url: conflict.url } } : {}),
      },
    });
    await notifySubmissionResultBestEffort(env, id, waitUntil);
    return jsonResponse(
      request,
      env,
      { ok: true, status: "approved", count: document.icons.length, replaced: Boolean(conflict) },
      { status: 200, headers: { ETag: serializedEtag } },
    );
  } catch (error) {
    if (!published) {
      await resetToPending(env, id);
      return jsonResponse(request, env, { error: error.message || "Failed to publish submission" }, { status: 500 });
    }
    // KV already contains the icon. Reconcile D1 instead of returning the
    // submission to "pending" (which is what caused the duplicate-name loop).
    try {
      await finalizeApproval(env, id, reviewerId, effectiveName, editFields);
      await writeAuditLog(env, {
        actorId: reviewerId,
        action: "submission-approved",
        targetId: id,
        details: { name: effectiveName, url: effectiveUrl, recovered: true },
      });
      await notifySubmissionResultBestEffort(env, id, waitUntil);
      return jsonResponse(request, env, { ok: true, status: "approved", count: publishedCount, recovered: true });
    } catch (recoveryError) {
      return jsonResponse(
        request,
        env,
        {
          error: `图标已写入 KV，但提交状态更新失败：${recoveryError.message || "未知错误"}。请重试以完成同步。`,
          code: "PUBLISH_RECOVERY_REQUIRED",
        },
        { status: 500 },
      );
    }
  } finally {
    try {
      await releasePublicationLock(env, lockOwner);
    } catch {
      // Lock rows expire on their own (30s TTL).
    }
  }
}

export function handleSubmissionOptions(request, env) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}
