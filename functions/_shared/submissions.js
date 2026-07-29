import {
  createEtag,
  readDocument,
  saveDocumentSnapshot,
  writeAuditLog,
} from "./icons.js";
import { hasAdminAccess } from "./admin.js";
import { queueSubmissionNotification } from "./telegram.js";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_NAME_LENGTH = 120;
const MAX_URL_LENGTH = 2048;
const MAX_NOTE_LENGTH = 1000;
const DEFAULT_SUBMISSIONS_PER_IP_PER_DAY = 20;

function corsHeaders(request, env) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, If-Match, X-Submission-Token, X-Turnstile-Token",
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

async function hashValue(value, env) {
  const secret = String(env.SUBMISSION_HASH_SECRET || env.ADMIN_TOKEN || "local-development-secret");
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

  const note = value.note === undefined ? "" : trimString(value.note, "note", MAX_NOTE_LENGTH, false);
  if (typeof note !== "string") return { error: note };
  return { value: { name, url: url.href, note } };
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

async function verifyTurnstile(request, env, body) {
  const secret = String(env.TURNSTILE_SECRET_KEY || "").trim();
  if (!secret) {
    if (String(env.REQUIRE_TURNSTILE).toLowerCase() === "true") return "Turnstile is not configured";
    return null;
  }
  const token = String(body.turnstileToken || request.headers.get("X-Turnstile-Token") || "").trim();
  if (!token) return "Turnstile verification is required";

  const form = new URLSearchParams({ secret, response: token });
  const ip = getIp(request);
  if (ip !== "unknown") form.set("remoteip", ip);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!response.ok) return "Turnstile verification failed";
  const result = await response.json();
  return result.success ? null : "Turnstile verification failed";
}

async function readSubmission(env, id) {
  return env.DB.prepare(
    `SELECT id, name, url, note, status, submitter_token_hash, ip_hash, created_at,
            reviewer_id, reviewer_note, reviewed_at
       FROM submissions WHERE id = ?1`,
  )
    .bind(id)
    .first();
}

function publicSubmission(row) {
  if (!row) return null;
  const { submitter_token_hash: _token, ip_hash: _ip, ...safe } = row;
  return safe;
}

async function requireSubmissionOwner(request, env, id) {
  const token = String(request.headers.get("X-Submission-Token") || "").trim();
  if (!token) return { response: jsonResponse(request, env, { error: "Submission token is required" }, { status: 401 }) };
  const row = await readSubmission(env, id);
  if (!row) return { response: jsonResponse(request, env, { error: "Submission not found" }, { status: 404 }) };
  const tokenHash = await hashValue(token, env);
  if (tokenHash !== row.submitter_token_hash) {
    return { response: jsonResponse(request, env, { error: "Invalid submission token" }, { status: 403 }) };
  }
  return { row };
}

async function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return jsonResponse(request, env, { error: "ADMIN_TOKEN is not configured" }, { status: 503 });
  if (!(await hasAdminAccess(request, env))) {
    return jsonResponse(request, env, { error: "Invalid admin session" }, { status: 401 });
  }
  return null;
}

async function acquirePublicationLock(env, owner) {
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

async function releasePublicationLock(env, owner) {
  await env.DB.prepare("DELETE FROM document_publish_lock WHERE lock_name = 'canonical' AND owner = ?1").bind(owner).run();
}

export async function handleSubmissionCreate(request, env, waitUntil) {
  const missingDb = requireDatabase(request, env);
  if (missingDb) return missingDb;

  let body;
  try {
    body = await readJson(request, env);
  } catch (error) {
    return jsonResponse(request, env, { error: error.message }, { status: 400 });
  }
  const turnstileError = await verifyTurnstile(request, env, body);
  if (turnstileError) return jsonResponse(request, env, { error: turnstileError }, { status: 403 });

  const validation = validateSubmission(body);
  if (validation.error) return jsonResponse(request, env, { error: validation.error }, { status: 400 });

  const ipHash = await hashValue(getIp(request), env);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const rate = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM submissions WHERE ip_hash = ?1 AND created_at >= ?2 AND status != 'withdrawn'",
  )
    .bind(ipHash, cutoff)
    .first();
  if (Number(rate?.count || 0) >= getDailySubmissionLimit(env)) {
    return jsonResponse(request, env, { error: "今日提交次数已达上限，请稍后再试。", limit: getDailySubmissionLimit(env) }, { status: 429, headers: { "Retry-After": "86400" } });
  }

  const id = crypto.randomUUID();
  const accessToken = createToken();
  const tokenHash = await hashValue(accessToken, env);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO submissions
      (id, name, url, note, status, submitter_token_hash, ip_hash, created_at)
     VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7)`,
  )
    .bind(id, validation.value.name, validation.value.url, validation.value.note, tokenHash, ipHash, now)
    .run();

  await writeAuditLog(env, {
    actorId: `submission:${id}`,
    action: "submission-created",
    targetId: id,
    details: { name: validation.value.name, url: validation.value.url },
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
    { ok: true, submission: { id, status: "pending", name: validation.value.name, url: validation.value.url }, accessToken },
    { status: 201 },
  );
}

export async function handleSubmissionItem(request, env, id) {
  const missingDb = requireDatabase(request, env);
  if (missingDb) return missingDb;
  const ownership = await requireSubmissionOwner(request, env, id);
  if (ownership.response) return ownership.response;
  const { row } = ownership;

  if (request.method === "GET") return jsonResponse(request, env, { submission: publicSubmission(row) });
  if (request.method === "POST") {
    if (row.status !== "pending") return jsonResponse(request, env, { error: "Only pending submissions can be withdrawn" }, { status: 409 });
    await env.DB.prepare("UPDATE submissions SET status = 'withdrawn' WHERE id = ?1 AND status = 'pending'").bind(id).run();
    await writeAuditLog(env, { actorId: `submission:${id}`, action: "submission-withdrawn", targetId: id });
    return jsonResponse(request, env, { ok: true, status: "withdrawn" });
  }
  if (request.method !== "PATCH") return jsonResponse(request, env, { error: "Method not allowed" }, { status: 405 });
  if (row.status !== "pending") return jsonResponse(request, env, { error: "Only pending submissions can be edited" }, { status: 409 });

  let body;
  try {
    body = await readJson(request, env);
  } catch (error) {
    return jsonResponse(request, env, { error: error.message }, { status: 400 });
  }
  const validation = validateSubmission(body);
  if (validation.error) return jsonResponse(request, env, { error: validation.error }, { status: 400 });
  await env.DB.prepare("UPDATE submissions SET name = ?1, url = ?2, note = ?3 WHERE id = ?4 AND status = 'pending'")
    .bind(validation.value.name, validation.value.url, validation.value.note, id)
    .run();
  await writeAuditLog(env, { actorId: `submission:${id}`, action: "submission-updated", targetId: id, details: validation.value });
  return jsonResponse(request, env, { ok: true, submission: { ...publicSubmission(row), ...validation.value } });
}

export async function handleAdminSubmissionList(request, env) {
  const missingDb = requireDatabase(request, env);
  if (missingDb) return missingDb;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "pending";
  const allowedStatuses = new Set(["pending", "approved", "rejected", "withdrawn", "all"]);
  if (!allowedStatuses.has(status)) return jsonResponse(request, env, { error: "Invalid status" }, { status: 400 });
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 100);
  const query = status === "all"
    ? "SELECT id, name, url, note, status, created_at, reviewer_id, reviewer_note, reviewed_at FROM submissions ORDER BY created_at DESC LIMIT ?1"
    : "SELECT id, name, url, note, status, created_at, reviewer_id, reviewer_note, reviewed_at FROM submissions WHERE status = ?1 ORDER BY created_at DESC LIMIT ?2";
  const result = status === "all"
    ? await env.DB.prepare(query).bind(limit).all()
    : await env.DB.prepare(query).bind(status, limit).all();
  return jsonResponse(request, env, { submissions: result.results || [] });
}

export async function handleAdminSubmissionDecision(request, env, id) {
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
  if (!["approve", "reject"].includes(action)) return jsonResponse(request, env, { error: "action must be approve or reject" }, { status: 400 });
  if (row.status !== "pending") return jsonResponse(request, env, { error: "Only pending submissions can be reviewed" }, { status: 409 });

  const reviewerId = "admin";
  if (action === "reject") {
    const note = body.note === undefined ? "" : trimString(body.note, "note", MAX_NOTE_LENGTH, false);
    if (typeof note !== "string") return jsonResponse(request, env, { error: note }, { status: 400 });
    await env.DB.prepare(
      "UPDATE submissions SET status = 'rejected', reviewer_id = ?1, reviewer_note = ?2, reviewed_at = ?3 WHERE id = ?4 AND status = 'pending'",
    )
      .bind(reviewerId, note, Date.now(), id)
      .run();
    await writeAuditLog(env, { actorId: reviewerId, action: "submission-rejected", targetId: id, details: { note } });
    return jsonResponse(request, env, { ok: true, status: "rejected" });
  }

  const claimed = await env.DB.prepare("UPDATE submissions SET status = 'approving' WHERE id = ?1 AND status = 'pending'").bind(id).run();
  if (!claimed.meta?.changes) return jsonResponse(request, env, { error: "Submission is already being reviewed" }, { status: 409 });

  const lockOwner = `submission:${id}:${crypto.randomUUID()}`;
  let lockAcquired = false;
  try {
    lockAcquired = await acquirePublicationLock(env, lockOwner);
  } catch (error) {
    await env.DB.prepare("UPDATE submissions SET status = 'pending' WHERE id = ?1 AND status = 'approving'").bind(id).run();
    return jsonResponse(request, env, { error: error.message || "Publication lock is unavailable" }, { status: 503 });
  }
  if (!lockAcquired) {
    await env.DB.prepare("UPDATE submissions SET status = 'pending' WHERE id = ?1 AND status = 'approving'").bind(id).run();
    return jsonResponse(request, env, { error: "Another publication is in progress; try again" }, { status: 409 });
  }

  try {
    if (!env.EMBY_ICONS) throw new Error("EMBY_ICONS KV is not configured");
    const current = await readDocument(env);
    const document = current.text === null
      ? { name: "Emby Icons", description: "", icons: [] }
      : JSON.parse(current.text);
    if (!Array.isArray(document.icons)) throw new Error("Published icon document is invalid");
    const duplicate = document.icons.some((icon) => icon.name?.trim().toLocaleLowerCase() === row.name.trim().toLocaleLowerCase());
    if (duplicate) {
      await env.DB.prepare("UPDATE submissions SET status = 'pending' WHERE id = ?1 AND status = 'approving'").bind(id).run();
      return jsonResponse(request, env, { error: "An icon with the same name already exists" }, { status: 409 });
    }
    document.icons.push({ name: row.name, url: row.url });
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    await saveDocumentSnapshot(env, current.text, reviewerId, `approve-submission:${id}`);
    await env.EMBY_ICONS.put("emby-icons.json", serialized);
    const updated = await env.DB.prepare(
      "UPDATE submissions SET status = 'approved', reviewer_id = ?1, reviewed_at = ?2 WHERE id = ?3 AND status = 'approving'",
    )
      .bind(reviewerId, Date.now(), id)
      .run();
    if (!updated.meta?.changes) throw new Error("Submission state changed while publishing");
    await writeAuditLog(env, {
      actorId: reviewerId,
      action: "submission-approved",
      targetId: id,
      details: { name: row.name, url: row.url, etag: await createEtag(serialized) },
    });
    return jsonResponse(request, env, { ok: true, status: "approved", count: document.icons.length }, { status: 200, headers: { ETag: await createEtag(serialized) } });
  } catch (error) {
    await env.DB.prepare("UPDATE submissions SET status = 'pending' WHERE id = ?1 AND status = 'approving'").bind(id).run();
    return jsonResponse(request, env, { error: error.message || "Failed to publish submission" }, { status: 500 });
  } finally {
    await releasePublicationLock(env, lockOwner);
  }
}

export function handleSubmissionOptions(request, env) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}
