import { hasAdminAccess } from "./admin.js";

export const REMOTE_JSON_URLS_KEY = "settings/remote-json-urls.json";
export const MAX_REMOTE_JSON_URLS = 50;
export const MAX_REMOTE_JSON_URL_NOTE_LENGTH = 100;

const STORE_VERSION = 1;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_URL_LENGTH = 2048;

function corsHeaders(request) {
  return {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, If-None-Match",
    "Access-Control-Expose-Headers": "ETag",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
  };
}

function jsonResponse(request, body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  Object.entries(corsHeaders(request)).forEach(([name, value]) => headers.set(name, value));
  const origin = request.headers.get("Origin");
  if (origin === new URL(request.url).origin) headers.set("Access-Control-Allow-Origin", origin);
  return new Response(JSON.stringify(body), { ...init, headers });
}

function storeEtag(store) {
  const serialized = JSON.stringify(store);
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `W/"${(hash >>> 0).toString(36)}"`;
}

function matchesEtag(header, etag) {
  if (!header) return false;
  return header.split(",").some((value) => {
    const candidate = value.trim();
    return candidate === "*" || candidate === etag;
  });
}

function notModifiedResponse(request, etag) {
  const headers = new Headers(corsHeaders(request));
  headers.set("ETag", etag);
  return new Response(null, { status: 304, headers });
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function errorResponse(request, error) {
  const status = Number(error?.status) || 500;
  return jsonResponse(request, { error: error?.message || "远程地址操作失败" }, { status });
}

function isBlockedHostname(hostname) {
  const host = hostname.toLowerCase().replace(/[\[\]]/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "::1" || host === "0.0.0.0" || host === "127.0.0.1") return true;
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ipv4) return false;
  const [a, b] = ipv4.slice(1, 3).map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0 || (a === 169 && b === 254);
}

export function validateRemoteUrl(value) {
  if (typeof value !== "string") return { error: "Remote URL is invalid" };
  const trimmed = value.trim();
  if (!trimmed) return { error: "Remote URL is required" };
  if (trimmed.length > MAX_URL_LENGTH) return { error: "Remote URL must not exceed 2048 characters" };

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { error: "Remote URL is invalid" };
  }
  if (!["http:", "https:"].includes(url.protocol)) return { error: "Remote URL must use HTTP or HTTPS" };
  if (url.username || url.password) return { error: "Remote URL must not contain credentials" };
  if (url.port && !["80", "443"].includes(url.port)) return { error: "Remote URL uses an unsupported port" };
  if (isBlockedHostname(url.hostname)) return { error: "Remote URL points to a private or local host" };
  return { url };
}

function validateRemoteNote(value) {
  if (value === undefined || value === null) return { note: "" };
  if (typeof value !== "string") return { error: "Remote note must be a string" };
  const note = value.trim();
  if (Array.from(note).length > MAX_REMOTE_JSON_URL_NOTE_LENGTH) {
    return { error: `Remote note must not exceed ${MAX_REMOTE_JSON_URL_NOTE_LENGTH} characters` };
  }
  return { note };
}

async function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return jsonResponse(request, { error: "ADMIN_TOKEN is not configured" }, { status: 503 });
  if (!(await hasAdminAccess(request, env))) return jsonResponse(request, { error: "Invalid admin session" }, { status: 401 });
  if (!env.EMBY_ICONS) return jsonResponse(request, { error: "EMBY_ICONS KV is not configured" }, { status: 503 });
  return null;
}

async function readStore(env) {
  const raw = await env.EMBY_ICONS.get(REMOTE_JSON_URLS_KEY);
  if (!raw) return { version: STORE_VERSION, updatedAt: 0, items: [] };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw httpError(500, "远程地址配置无效，请检查 KV 数据");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.items)) {
    throw httpError(500, "远程地址配置无效，请检查 KV 数据");
  }

  const items = [];
  const ids = new Set();
  for (const item of parsed.items) {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.id !== "string" || !item.id) {
      throw httpError(500, "远程地址配置中存在无效记录");
    }
    const checked = validateRemoteUrl(item.url);
    if (checked.error) throw httpError(500, "远程地址配置中存在无效 URL");
    const checkedNote = validateRemoteNote(item.note ?? "");
    if (checkedNote.error) throw httpError(500, "远程地址配置中存在无效备注");
    if (ids.has(item.id)) throw httpError(500, "远程地址配置中存在重复 ID");
    ids.add(item.id);
    items.push({
      id: item.id,
      url: checked.url.href,
      note: checkedNote.note,
      createdAt: Number(item.createdAt) || 0,
      updatedAt: Number(item.updatedAt) || 0,
    });
  }

  return {
    version: STORE_VERSION,
    updatedAt: Number(parsed.updatedAt) || 0,
    items,
  };
}

async function writeStore(env, store) {
  try {
    await env.EMBY_ICONS.put(REMOTE_JSON_URLS_KEY, JSON.stringify(store));
  } catch {
    throw httpError(503, "远程地址保存失败，请检查 EMBY_ICONS KV 绑定");
  }
}

async function readBody(request) {
  const declaredSize = Number(request.headers.get("Content-Length") || 0);
  if (declaredSize > MAX_BODY_BYTES) throw httpError(400, "请求内容过大");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) throw httpError(400, "请求内容过大");
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw httpError(400, "请求内容不是有效的 JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw httpError(400, "请求内容必须是 JSON 对象");
  return body;
}

async function readBodyUrlAndNote(request, fallbackNote = "") {
  const body = await readBody(request);
  const checkedUrl = validateRemoteUrl(body.url);
  if (checkedUrl.error) throw httpError(400, checkedUrl.error);
  const checkedNote = validateRemoteNote(Object.hasOwn(body, "note") ? body.note : fallbackNote);
  if (checkedNote.error) throw httpError(400, checkedNote.error);
  return { url: checkedUrl.url.href, note: checkedNote.note };
}

export async function handleAdminRemoteJsonUrlCollection(request, env) {
  const authError = await requireAdmin(request, env);
  if (authError) return authError;
  if (!["GET", "POST"].includes(request.method)) {
    return jsonResponse(request, { error: "Method not allowed" }, { status: 405, headers: { Allow: "GET, POST, OPTIONS" } });
  }

  try {
    const store = await readStore(env);
    if (request.method === "GET") {
      const etag = storeEtag(store);
      if (matchesEtag(request.headers.get("If-None-Match"), etag)) return notModifiedResponse(request, etag);
      return jsonResponse(request, store, { headers: { ETag: etag } });
    }

    const { url, note } = await readBodyUrlAndNote(request);
    if (store.items.some((item) => item.url === url)) {
      return jsonResponse(request, { error: "该远程地址已保存" }, { status: 409 });
    }
    if (store.items.length >= MAX_REMOTE_JSON_URLS) {
      return jsonResponse(request, { error: `最多只能保存 ${MAX_REMOTE_JSON_URLS} 个远程地址` }, { status: 409 });
    }

    const now = Date.now();
    const item = { id: crypto.randomUUID(), url, note, createdAt: now, updatedAt: now };
    store.items.unshift(item);
    store.updatedAt = now;
    await writeStore(env, store);
    return jsonResponse(request, { item, count: store.items.length, updatedAt: store.updatedAt }, {
      status: 201,
      headers: { ETag: storeEtag(store) },
    });
  } catch (error) {
    return errorResponse(request, error);
  }
}

export async function handleAdminRemoteJsonUrlItem(request, env, id) {
  const authError = await requireAdmin(request, env);
  if (authError) return authError;
  if (!["GET", "PUT", "DELETE"].includes(request.method)) {
    return jsonResponse(request, { error: "Method not allowed" }, { status: 405, headers: { Allow: "GET, PUT, DELETE, OPTIONS" } });
  }

  const itemId = typeof id === "string" ? id.trim() : "";
  if (!itemId) return jsonResponse(request, { error: "Remote URL id is required" }, { status: 404 });

  try {
    const store = await readStore(env);
    const index = store.items.findIndex((item) => item.id === itemId);
    if (index === -1) return jsonResponse(request, { error: "Remote URL not found" }, { status: 404 });
    const current = store.items[index];

    if (request.method === "GET") {
      const etag = storeEtag(store);
      if (matchesEtag(request.headers.get("If-None-Match"), etag)) return notModifiedResponse(request, etag);
      return jsonResponse(request, { item: current }, { headers: { ETag: etag } });
    }
    if (request.method === "DELETE") {
      store.items.splice(index, 1);
      store.updatedAt = Date.now();
      await writeStore(env, store);
      return jsonResponse(request, { ok: true, id: itemId, count: store.items.length, updatedAt: store.updatedAt }, {
        headers: { ETag: storeEtag(store) },
      });
    }

    const { url, note } = await readBodyUrlAndNote(request, current.note);
    if (store.items.some((item, itemIndex) => itemIndex !== index && item.url === url)) {
      return jsonResponse(request, { error: "该远程地址已保存" }, { status: 409 });
    }
    const updated = { ...current, url, note, updatedAt: Date.now() };
    store.items[index] = updated;
    store.updatedAt = updated.updatedAt;
    await writeStore(env, store);
    return jsonResponse(request, { item: updated, count: store.items.length, updatedAt: store.updatedAt }, {
      headers: { ETag: storeEtag(store) },
    });
  } catch (error) {
    return errorResponse(request, error);
  }
}

export function handleRemoteJsonUrlOptions(request) {
  const headers = new Headers(corsHeaders(request));
  const origin = request.headers.get("Origin");
  if (origin === new URL(request.url).origin) headers.set("Access-Control-Allow-Origin", origin);
  return new Response(null, { status: 204, headers });
}

