import { hasAdminAccess } from "./admin.js";
import {
  STORAGE_KEY,
  buildDuplicateIconConflict,
  createEtag,
  findDuplicateIcon,
  readDocument,
  saveDocumentSnapshot,
  validateDocument,
  writeAuditLog,
} from "./icons.js";
import { acquirePublicationLock, releasePublicationLock } from "./submissions.js";

const MAX_RESTORE_BODY_BYTES = 8 * 1024;
const MAX_DOCUMENT_BYTES = 1024 * 1024;

function jsonResponse(body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(body), { ...init, headers });
}

async function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return jsonResponse({ error: "ADMIN_TOKEN is not configured" }, { status: 503 });
  if (!(await hasAdminAccess(request, env))) {
    return jsonResponse({ error: "Invalid admin session" }, { status: 401 });
  }
  return null;
}

function parseVersionId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function versionSummary(row) {
  const sizeBytes = Number(row.size_bytes);
  return {
    id: Number(row.id),
    etag: String(row.etag || ""),
    actorId: String(row.actor_id || "system"),
    reason: String(row.reason || "update"),
    createdAt: Number(row.created_at || 0),
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : new TextEncoder().encode(String(row.document_json || "")).byteLength,
  };
}

async function readVersion(env, id) {
  return env.DB.prepare(
    `SELECT id, document_json, etag, actor_id, reason, created_at
       FROM document_versions
      WHERE id = ?1`,
  )
    .bind(id)
    .first();
}

export async function handleAdminVersionList(request, env) {
  if (!env.DB) return jsonResponse({ error: "DB binding is not configured" }, { status: 503 });
  const authError = await requireAdmin(request, env);
  if (authError) return authError;

  const url = new URL(request.url);
  const requestedLimit = Number(url.searchParams.get("limit") || 30);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100)
    : 30;
  const cursorParam = url.searchParams.get("cursor") || "";
  const cursor = cursorParam ? parseVersionId(cursorParam) : null;
  if (cursorParam && !cursor) return jsonResponse({ error: "Invalid cursor" }, { status: 400 });

  const result = await env.DB.prepare(
    `SELECT id, etag, actor_id, reason, created_at, length(document_json) AS size_bytes
       FROM document_versions
      WHERE (?1 = 0 OR id < ?2)
      ORDER BY id DESC
      LIMIT ?3`,
  )
    .bind(cursor ? 1 : 0, cursor || 0, limit + 1)
    .all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return jsonResponse({
    versions: page.map(versionSummary),
    nextCursor: hasMore && page.length ? String(page[page.length - 1].id) : null,
  });
}

export async function handleAdminVersionItem(request, env, idValue) {
  if (!env.DB) return jsonResponse({ error: "DB binding is not configured" }, { status: 503 });
  const authError = await requireAdmin(request, env);
  if (authError) return authError;
  const id = parseVersionId(idValue);
  if (!id) return jsonResponse({ error: "Invalid version id" }, { status: 400 });

  const row = await readVersion(env, id);
  if (!row) return jsonResponse({ error: "Version not found" }, { status: 404 });

  if (request.method === "GET") {
    let document;
    try {
      document = JSON.parse(row.document_json);
    } catch {
      return jsonResponse({ error: "Version data is not valid JSON" }, { status: 500 });
    }
    let currentEtag = null;
    try {
      currentEtag = (await readDocument(env)).etag;
    } catch (error) {
      return jsonResponse({ error: error.message || "KV is unavailable" }, { status: 503 });
    }
    const summary = versionSummary(row);
    return jsonResponse({
      version: {
        ...summary,
        document,
        iconCount: Array.isArray(document?.icons) ? document.icons.length : 0,
      },
      currentEtag,
    });
  }

  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, { status: 405 });

  if (!env.EMBY_ICONS) return jsonResponse({ error: "EMBY_ICONS KV is not configured" }, { status: 503 });
  const declaredSize = Number(request.headers.get("Content-Length") || 0);
  if (declaredSize > MAX_RESTORE_BODY_BYTES) return jsonResponse({ error: "Request body is too large" }, { status: 413 });
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_RESTORE_BODY_BYTES) {
    return jsonResponse({ error: "Request body is too large" }, { status: 413 });
  }
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return jsonResponse({ error: "Request body is not valid JSON" }, { status: 400 });
  }
  if (body?.action !== "restore") {
    return jsonResponse({ error: "action must be restore" }, { status: 400 });
  }
  const expectedEtag = typeof body.expectedEtag === "string" ? body.expectedEtag.trim() : "";
  if (expectedEtag.length > 256) return jsonResponse({ error: "expectedEtag is too long" }, { status: 400 });

  let document;
  try {
    document = JSON.parse(row.document_json);
  } catch {
    return jsonResponse({ error: "Version data is not valid JSON" }, { status: 500 });
  }
  const validationError = validateDocument(document);
  if (validationError) return jsonResponse({ error: `Version is invalid: ${validationError}` }, { status: 409 });
  const duplicate = findDuplicateIcon(document.icons);
  if (duplicate) {
    return jsonResponse(buildDuplicateIconConflict(duplicate, document.icons), { status: 409 });
  }

  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (new TextEncoder().encode(serialized).byteLength > MAX_DOCUMENT_BYTES) {
    return jsonResponse({ error: "Version is larger than 1 MB" }, { status: 413 });
  }

  const lockOwner = `version-restore:${id}:${crypto.randomUUID()}`;
  let lockAcquired = false;
  try {
    lockAcquired = await acquirePublicationLock(env, lockOwner);
  } catch (error) {
    return jsonResponse({ error: error.message || "Publication lock is unavailable" }, { status: 503 });
  }
  if (!lockAcquired) {
    return jsonResponse({ error: "Another publication is in progress; try again" }, { status: 409 });
  }

  try {
    const current = await readDocument(env);
    if (current.etag && !expectedEtag) {
      return jsonResponse({ error: "expectedEtag is required when a document is published", code: "ETAG_REQUIRED" }, { status: 400 });
    }
    if (expectedEtag && expectedEtag !== current.etag) {
      return jsonResponse(
        { error: "The published document changed. Reload the version history before restoring.", code: "ETAG_MISMATCH" },
        { status: 412, headers: current.etag ? { ETag: current.etag } : {} },
      );
    }

    // Snapshot the current document first so an accidental rollback can itself
    // be undone from the version history.
    await saveDocumentSnapshot(env, current.text, "admin", `before-restore:${id}`);
    await env.EMBY_ICONS.put(STORAGE_KEY, serialized);
    const etag = await createEtag(serialized);
    await writeAuditLog(env, {
      actorId: "admin",
      action: "document-version-restored",
      targetId: String(id),
      details: { etag, previousEtag: current.etag, iconCount: document.icons.length },
    });
    return jsonResponse(
      { ok: true, restored: true, versionId: id, etag, count: document.icons.length },
      { status: 200, headers: { ETag: etag, "X-Emby-Icons-Source": "kv" } },
    );
  } catch (error) {
    return jsonResponse({ error: error.message || "Failed to restore version" }, { status: 500 });
  } finally {
    try {
      await releasePublicationLock(env, lockOwner);
    } catch {
      // The lock expires automatically after 30 seconds.
    }
  }
}

export function handleVersionOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, If-Match",
      "Cache-Control": "no-store",
    },
  });
}