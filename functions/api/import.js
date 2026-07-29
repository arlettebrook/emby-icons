import { isAuthorized } from "../_shared/icons.js";

const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 8_000;

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

function isBlockedHostname(hostname) {
  const host = hostname.toLowerCase().replace(/[\[\]]/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "::1" || host === "0.0.0.0" || host === "127.0.0.1") return true;
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ipv4) return false;
  const [a, b] = ipv4.slice(1, 3).map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0 || (a === 169 && b === 254);
}

function validateRemoteUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return { error: "Remote URL is invalid" };
  }
  if (!["http:", "https:"].includes(url.protocol)) return { error: "Remote URL must use HTTP or HTTPS" };
  if (url.username || url.password) return { error: "Remote URL must not contain credentials" };
  if (url.port && !["80", "443"].includes(url.port)) return { error: "Remote URL uses an unsupported port" };
  if (isBlockedHostname(url.hostname)) return { error: "Remote URL points to a private or local host" };
  return { url };
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

export async function onRequestPost({ request, env }) {
  if (!env.ADMIN_TOKEN) return response(request, { error: "ADMIN_TOKEN is not configured" }, { status: 503 });
  if (!(await isAuthorized(request, env))) return response(request, { error: "Invalid admin token" }, { status: 401 });
  try {
    const url = await readRequestUrl(request);
    const value = await fetchRemoteJson(url);
    return response(request, { ok: true, value });
  } catch (error) {
    return response(request, { error: error.message }, { status: 400 });
  }
}

export function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: { ...corsHeaders, "Access-Control-Allow-Origin": new URL(request.url).origin } });
}
