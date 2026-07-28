const STORAGE_KEY = "emby-icons.json";
const MAX_DOCUMENT_BYTES = 1024 * 1024;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, If-Match",
};

function jsonResponse(body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  Object.entries(corsHeaders).forEach(([name, value]) => headers.set(name, value));
  return new Response(JSON.stringify(body), { ...init, headers });
}

function validateDocument(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return "根节点必须是 JSON 对象";
  }

  if (typeof document.name !== "string" || !document.name.trim()) {
    return "name 必须是非空字符串";
  }

  if (typeof document.description !== "string") {
    return "description 必须是字符串";
  }

  if (!Array.isArray(document.icons)) {
    return "icons 必须是数组";
  }

  for (let index = 0; index < document.icons.length; index += 1) {
    const icon = document.icons[index];
    if (!icon || typeof icon !== "object" || Array.isArray(icon)) {
      return `icons[${index}] 必须是对象`;
    }
    if (typeof icon.name !== "string" || !icon.name.trim()) {
      return `icons[${index}].name 必须是非空字符串`;
    }
    if (typeof icon.url !== "string" || !icon.url.trim()) {
      return `icons[${index}].url 必须是非空字符串`;
    }

    try {
      const url = new URL(icon.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return `icons[${index}].url 仅支持 HTTP 或 HTTPS`;
      }
    } catch {
      return `icons[${index}].url 不是有效网址`;
    }
  }

  return null;
}

async function createEtag(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `"${hash}"`;
}

async function readSeed(request, env) {
  const seedUrl = new URL("/emby-icons.seed.json", request.url);
  const response = await env.ASSETS.fetch(seedUrl);
  if (!response.ok) {
    throw new Error("无法读取初始 emby-icons.json");
  }
  return response.text();
}

async function readDocument(request, env) {
  const stored = env.EMBY_ICONS ? await env.EMBY_ICONS.get(STORAGE_KEY) : null;
  const text = stored ?? (await readSeed(request, env));
  return { text, etag: await createEtag(text), source: stored === null ? "seed" : "kv" };
}

function isAuthorized(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  return request.headers.get("Authorization") === `Bearer ${env.ADMIN_TOKEN}`;
}

export async function handleGet(request, env, cacheControl = "no-cache") {
  try {
    const { text, etag, source } = await readDocument(request, env);
    return new Response(text, {
      headers: {
        ...corsHeaders,
        "Cache-Control": cacheControl,
        "Content-Type": "application/json; charset=utf-8",
        ETag: etag,
        "X-Emby-Icons-Source": source,
      },
    });
  } catch (error) {
    return jsonResponse({ error: error.message }, { status: 500 });
  }
}

export async function handlePut(request, env) {
  if (!env.ADMIN_TOKEN) {
    return jsonResponse({ error: "服务端尚未配置 ADMIN_TOKEN" }, { status: 503 });
  }

  if (!isAuthorized(request, env)) {
    return jsonResponse({ error: "管理员令牌无效" }, { status: 401 });
  }

  if (!env.EMBY_ICONS) {
    return jsonResponse({ error: "服务端尚未绑定 EMBY_ICONS KV" }, { status: 503 });
  }

  const declaredSize = Number(request.headers.get("Content-Length") || 0);
  if (declaredSize > MAX_DOCUMENT_BYTES) {
    return jsonResponse({ error: "JSON 文件不能超过 1 MB" }, { status: 413 });
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_DOCUMENT_BYTES) {
    return jsonResponse({ error: "JSON 文件不能超过 1 MB" }, { status: 413 });
  }

  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    return jsonResponse({ error: "请求内容不是有效 JSON" }, { status: 400 });
  }

  const validationError = validateDocument(document);
  if (validationError) {
    return jsonResponse({ error: validationError }, { status: 400 });
  }

  const current = await readDocument(request, env);
  const expectedEtag = request.headers.get("If-Match");
  if (expectedEtag && expectedEtag !== "*" && expectedEtag !== current.etag) {
    return jsonResponse(
      { error: "云端内容已被其他会话更新，请重新加载后再保存" },
      { status: 412, headers: { ETag: current.etag } },
    );
  }

  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  await env.EMBY_ICONS.put(STORAGE_KEY, serialized);
  const etag = await createEtag(serialized);

  return jsonResponse(
    { ok: true, updatedAt: new Date().toISOString(), count: document.icons.length },
    { status: 200, headers: { ETag: etag } },
  );
}

export function handleOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
}
