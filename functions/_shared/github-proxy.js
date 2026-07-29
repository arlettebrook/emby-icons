import { hasAdminAccess } from "./admin.js";

export const GITHUB_PROXY_SETTINGS_KEY = "settings/github-proxy.json";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_PROXY_URL_LENGTH = 2048;
const RAW_GITHUB_PREFIX = "https://raw.githubusercontent.com";

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

function normalizeProxyUrl(value) {
  const proxyUrl = String(value || "").trim().replace(/\/+$/, "");
  if (!proxyUrl) return "";
  if (proxyUrl.length > MAX_PROXY_URL_LENGTH) throw new Error("代理 URL 不能超过 2048 个字符");

  let parsed;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new Error("代理 URL 无效");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("代理 URL 必须使用 HTTP 或 HTTPS");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("代理 URL 不能包含用户名、密码、查询参数或片段");
  }
  return parsed.href.replace(/\/+$/, "");
}

export function isRawGithubUrl(value) {
  return typeof value === "string" && value.startsWith(RAW_GITHUB_PREFIX);
}

export function transformGithubProxyDocument(text, settings) {
  if (!settings.enabled || !settings.proxyUrl) return { text, changed: false };

  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return { text, changed: false };
  }
  if (!document || typeof document !== "object" || !Array.isArray(document.icons)) {
    return { text, changed: false };
  }

  let changed = false;
  const icons = document.icons.map((icon) => {
    if (!icon || typeof icon !== "object" || !isRawGithubUrl(icon.url)) return icon;
    changed = true;
    return { ...icon, url: `${settings.proxyUrl}/${icon.url}` };
  });
  if (!changed) return { text, changed: false };
  return { text: `${JSON.stringify({ ...document, icons }, null, 2)}\n`, changed: true };
}

export async function readGithubProxySettings(env) {
  if (!env.EMBY_ICONS) throw new Error("EMBY_ICONS KV is not configured");
  const raw = await env.EMBY_ICONS.get(GITHUB_PROXY_SETTINGS_KEY);
  if (!raw) return { enabled: false, proxyUrl: "" };
  try {
    const parsed = JSON.parse(raw);
    return {
      enabled: parsed.enabled === true,
      proxyUrl: normalizeProxyUrl(parsed.proxyUrl),
    };
  } catch {
    throw new Error("GitHub 代理配置无效");
  }
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

async function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return jsonResponse(request, { error: "ADMIN_TOKEN is not configured" }, { status: 503 });
  if (!(await hasAdminAccess(request, env))) return jsonResponse(request, { error: "Invalid admin session" }, { status: 401 });
  return null;
}

export async function handleAdminGithubProxySettings(request, env) {
  const authError = await requireAdmin(request, env);
  if (authError) return authError;
  if (!env.EMBY_ICONS) return jsonResponse(request, { error: "EMBY_ICONS KV is not configured" }, { status: 503 });

  let current;
  try {
    current = await readGithubProxySettings(env);
  } catch (error) {
    return jsonResponse(request, { error: error.message }, { status: 500 });
  }
  if (request.method === "GET") return jsonResponse(request, current);
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

  let proxyUrl;
  try {
    proxyUrl = normalizeProxyUrl(body.proxyUrl === undefined ? current.proxyUrl : body.proxyUrl);
  } catch (error) {
    return jsonResponse(request, { error: error.message }, { status: 400 });
  }
  const enabled = body.enabled === true;
  if (enabled && !proxyUrl) return jsonResponse(request, { error: "启用代理前请填写代理 URL" }, { status: 400 });

  const settings = { enabled, proxyUrl };
  try {
    await env.EMBY_ICONS.put(GITHUB_PROXY_SETTINGS_KEY, JSON.stringify({ ...settings, version: 1, updatedAt: Date.now() }));
  } catch {
    return jsonResponse(request, { error: "GitHub 代理配置保存失败，请检查 EMBY_ICONS KV 绑定" }, { status: 503 });
  }
  return jsonResponse(request, settings);
}

export function handleGithubProxyOptions(request) {
  return new Response(null, { status: 204, headers: responseHeaders(request) });
}
