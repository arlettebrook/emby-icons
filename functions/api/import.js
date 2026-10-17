import { hasAdminAccess } from "../_shared/admin.js";
import { validateRemoteUrl } from "../_shared/remote-json-urls.js";

const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 8_000;
const REMOTE_JSON_CACHE_TTL_MS = 60_000;
const REMOTE_JSON_CACHE_MAX_ENTRIES = 16;
const remoteJsonMemoryCache = new Map();
const remoteJsonPendingRequests = new Map();

const corsHeaders = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function response(request, body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  Object.entries(corsHeaders).forEach(([name, value]) => headers.set(name, value));
  const origin = request.headers.get("Origin");
  if (origin === new URL(request.url).origin) headers.set("Access-Control-Allow-Origin", origin);
  return new Response(JSON.stringify(body), { ...init, headers });
}

function memoryCacheGet(key) {
  const entry = remoteJsonMemoryCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    remoteJsonMemoryCache.delete(key);
    return undefined;
  }
  remoteJsonMemoryCache.delete(key);
  remoteJsonMemoryCache.set(key, entry);
  return entry.value;
}

function memoryCacheSet(key, value) {
  remoteJsonMemoryCache.delete(key);
  remoteJsonMemoryCache.set(key, { value, expiresAt: Date.now() + REMOTE_JSON_CACHE_TTL_MS });
  while (remoteJsonMemoryCache.size > REMOTE_JSON_CACHE_MAX_ENTRIES) {
    remoteJsonMemoryCache.delete(remoteJsonMemoryCache.keys().next().value);
  }
}

function sharedCache() {
  try {
    return globalThis.caches?.default || null;
  } catch {
    return null;
  }
}

function remoteJsonCacheKey(requestUrl, targetUrl) {
  const key = new URL("/__emby-icons/remote-json-cache", requestUrl);
  key.searchParams.set("url", targetUrl);
  return key.href;
}

async function sharedCacheGet(cacheKey) {
  const cache = sharedCache();
  if (!cache) return undefined;
  try {
    const cached = await cache.match(cacheKey);
    if (!cached) return undefined;
    const payload = await cached.json();
    if (!payload || typeof payload.cachedAt !== "number" || !Object.hasOwn(payload, "value")) return undefined;
    if (Date.now() - payload.cachedAt > REMOTE_JSON_CACHE_TTL_MS) return undefined;
    return payload.value;
  } catch {
    return undefined;
  }
}

async function sharedCacheSet(cacheKey, value) {
  const cache = sharedCache();
  if (!cache) return;
  try {
    const payload = JSON.stringify({ cachedAt: Date.now(), value });
    await cache.put(cacheKey, new Response(payload, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `max-age=${Math.floor(REMOTE_JSON_CACHE_TTL_MS / 1000)}`,
      },
    }));
  } catch {
    // The shared cache is best-effort; the in-memory cache still helps within an isolate.
  }
}

async function readRequestUrl(request) {
  const declaredSize = Number(request.headers.get("Content-Length") || 0);
  if (declaredSize > MAX_REQUEST_BYTES) throw new Error("Request body is too large");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) throw new Error("Request body is too large");
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error("Request body is not valid JSON");
  }
  if (!body || typeof body.url !== "string" || !body.url.trim()) throw new Error("url is required");
  return body.url.trim();
}

async function fetchRemoteJson(startUrl) {
  let currentUrl = startUrl;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const checked = validateRemoteUrl(currentUrl);
    if (checked.error) throw new Error(checked.error);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let remote;
    try {
      remote = await fetch(checked.url, { redirect: "manual", signal: controller.signal, headers: { Accept: "application/json, text/plain;q=0.9, */*;q=0.1" } });
    } catch (error) {
      throw new Error(error.name === "AbortError" ? "Remote request timed out" : "Remote request failed");
    } finally {
      clearTimeout(timeout);
    }
    if ([301, 302, 303, 307, 308].includes(remote.status)) {
      if (redirect === MAX_REDIRECTS) throw new Error("Too many remote redirects");
      const location = remote.headers.get("Location");
      if (!location) throw new Error("Remote redirect has no location");
      currentUrl = new URL(location, checked.url).href;
      continue;
    }
    if (!remote.ok) throw new Error(`Remote request failed (${remote.status})`);
    const contentLength = Number(remote.headers.get("Content-Length") || 0);
    if (contentLength > MAX_RESPONSE_BYTES) throw new Error("Remote JSON is larger than 1 MB");
    const raw = await remote.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES) throw new Error("Remote JSON is larger than 1 MB");
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("Remote response is not valid JSON");
    }
  }
  throw new Error("Remote request failed");
}

async function loadRemoteJson(request, startUrl) {
  const checked = validateRemoteUrl(startUrl);
  if (checked.error) throw new Error(checked.error);
  const key = checked.url.href;

  const cached = memoryCacheGet(key);
  if (cached !== undefined) return cached;

  const pending = remoteJsonPendingRequests.get(key);
  if (pending) return pending;

  const cacheKey = remoteJsonCacheKey(request.url, key);
  const requestPromise = (async () => {
    const shared = await sharedCacheGet(cacheKey);
    if (shared !== undefined) {
      memoryCacheSet(key, shared);
      return shared;
    }

    const value = await fetchRemoteJson(key);
    memoryCacheSet(key, value);
    await sharedCacheSet(cacheKey, value);
    return value;
  })();
  remoteJsonPendingRequests.set(key, requestPromise);
  try {
    return await requestPromise;
  } finally {
    remoteJsonPendingRequests.delete(key);
  }
}

export async function onRequestPost({ request, env }) {
  if (!env.ADMIN_TOKEN) return response(request, { error: "ADMIN_TOKEN is not configured" }, { status: 503 });
  if (!(await hasAdminAccess(request, env))) return response(request, { error: "Invalid admin session" }, { status: 401 });
  try {
    const url = await readRequestUrl(request);
    const value = await loadRemoteJson(request, url);
    return response(request, { ok: true, value });
  } catch (error) {
    return response(request, { error: error.message }, { status: 400 });
  }
}

export function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: { ...corsHeaders, "Access-Control-Allow-Origin": new URL(request.url).origin } });
}

