import { clearSessionCookie } from "../../_shared/admin.js";

export function onRequestPost({ request }) {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": clearSessionCookie(request),
    },
  });
}
