import { hasAdminSession } from "../../_shared/admin.js";

export async function onRequestGet({ request, env }) {
  return new Response(JSON.stringify({ ok: await hasAdminSession(request, env) }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
