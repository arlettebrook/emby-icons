import { isAuthorized } from "../../_shared/icons.js";
import { createAdminSession, sessionCookie } from "../../_shared/admin.js";

function json(body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export async function onRequestPost({ request, env }) {
  if (!env.ADMIN_TOKEN) return json({ error: "ADMIN_TOKEN is not configured" }, { status: 503 });
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Request body is not valid JSON" }, { status: 400 });
  }
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  const authorized = token && await isAuthorized(new Request(request.url, { headers: { Authorization: `Bearer ${token}` } }), env);
  if (!authorized) return json({ error: "Invalid admin token" }, { status: 401 });
  const headers = new Headers({ "Set-Cookie": sessionCookie(request, await createAdminSession(env)) });
  return json({ ok: true }, { headers });
}
