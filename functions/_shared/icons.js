const STORAGE_KEY = "emby-icons.json";
const MAX_DOCUMENT_BYTES = 1024 * 1024;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, If-Match, X-Force-Overwrite",
};

function jsonResponse(body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  Object.entries(corsHeaders).forEach(([name, value]) => headers.set(name, value));
  return new Response(JSON.stringify(body), { ...init, headers });
}

function validateDocument(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) return "Root must be a JSON object";
  if (typeof document.name !== "string" || !document.name.trim()) return "name must be a non-empty string";
  if (typeof document.description !== "string") return "description must be a string";
  if (!Array.isArray(document.icons)) return "icons must be an array";

  for (let index = 0; index < document.icons.length; index += 1) {
    const icon = document.icons[index];
    if (!icon || typeof icon !== "object" || Array.isArray(icon)) return `icons[${index}] must be an object`;
    if (typeof icon.name !== "string" || !icon.name.trim()) return `icons[${index}].name is required`;
    if (typeof icon.url !== "string" || !icon.url.trim()) return `icons[${index}].url is required`;
    try {
      const url = new URL(icon.url);
      if (!["http:", "https:"].includes(url.protocol)) return `icons[${index}].url must use HTTP or HTTPS`;
    } catch {
      return `icons[${index}].url is not a valid URL`;
    }
  }
  return null;
}

async function createEtag(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `"${hash}"`;
}

async function readDocument(env) {
  if (!env.EMBY_ICONS) throw new Error("EMBY_ICONS KV is not configured");
  const text = await env.EMBY_ICONS.get(STORAGE_KEY);
  return { text, etag: text === null ? null : await createEtag(text), source: "kv" };
}

async function isAuthorized(request, env) {
  const configuredToken = String(env.ADMIN_TOKEN || "").trim();
  const authorization = request.headers.get("Authorization") || "";
  const suppliedToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!configuredToken || !suppliedToken) return false;

  const encoder = new TextEncoder();
  const [configuredDigest, suppliedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(configuredToken)),
    crypto.subtle.digest("SHA-256", encoder.encode(suppliedToken)),
  ]);
  const configuredBytes = new Uint8Array(configuredDigest);
  const suppliedBytes = new Uint8Array(suppliedDigest);
  return configuredBytes.every((byte, index) => byte === suppliedBytes[index]);
}

export async function handleGet(request, env, cacheControl = "no-cache") {
  try {
    const { text, etag, source } = await readDocument(env);
    if (text === null) {
      return jsonResponse(
        { error: "KV has no icon data yet. Import a JSON document to get started." },
        {
          status: 404,
          headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
            "X-Emby-Icons-Source": source,
          },
        },
      );
    }

    return new Response(text, {
      headers: {
        ...corsHeaders,
        "Cache-Control": cacheControl === "no-cache" ? "no-store, no-cache, must-revalidate" : cacheControl,
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
  if (!env.ADMIN_TOKEN) return jsonResponse({ error: "ADMIN_TOKEN is not configured" }, { status: 503 });
  if (!(await isAuthorized(request, env))) return jsonResponse({ error: "Invalid admin token" }, { status: 401 });
  if (!env.EMBY_ICONS) return jsonResponse({ error: "EMBY_ICONS KV is not configured" }, { status: 503 });

  const declaredSize = Number(request.headers.get("Content-Length") || 0);
  if (declaredSize > MAX_DOCUMENT_BYTES) return jsonResponse({ error: "JSON must be smaller than 1 MB" }, { status: 413 });

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_DOCUMENT_BYTES) {
    return jsonResponse({ error: "JSON must be smaller than 1 MB" }, { status: 413 });
  }

  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    return jsonResponse({ error: "Request body is not valid JSON" }, { status: 400 });
  }

  const validationError = validateDocument(document);
  if (validationError) return jsonResponse({ error: validationError }, { status: 400 });

  const current = await readDocument(env);
  const expectedEtag = request.headers.get("If-Match");
  const forceOverwrite = request.headers.get("X-Force-Overwrite") === "true";
  if (!forceOverwrite && expectedEtag && expectedEtag !== "*" && expectedEtag !== current.etag) {
    return jsonResponse(
      { error: "Cloud document changed. Reload it before saving again." },
      { status: 412, headers: current.etag ? { ETag: current.etag } : {} },
    );
  }

  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  await env.EMBY_ICONS.put(STORAGE_KEY, serialized);
  const etag = await createEtag(serialized);
  return jsonResponse(
    { ok: true, updatedAt: new Date().toISOString(), count: document.icons.length },
    { status: 200, headers: { ETag: etag, "X-Emby-Icons-Source": "kv" } },
  );
}

export function handleOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
}
