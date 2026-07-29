import assert from "node:assert/strict";
import test from "node:test";

import { hasAdminSession, createAdminSession } from "../functions/_shared/admin.js";
import { onRequest } from "../functions/_middleware.js";

test("admin session cookie is signed and expires when tampered", async () => {
  const env = { ADMIN_TOKEN: "admin-secret", ADMIN_SESSION_SECRET: "session-secret" };
  const session = await createAdminSession(env);
  const request = new Request("https://example.com/admin.html", { headers: { Cookie: `emby_admin_session=${session}` } });
  assert.equal(await hasAdminSession(request, env), true);
  const tampered = new Request("https://example.com/admin.html", { headers: { Cookie: `emby_admin_session=${session}x` } });
  assert.equal(await hasAdminSession(tampered, env), false);
});

test("middleware redirects unauthenticated admin pages", async () => {
  const response = await onRequest({
    request: new Request("https://example.com/admin.html"),
    env: { ADMIN_TOKEN: "admin-secret" },
    next: async () => new Response("ok"),
  });
  assert.equal(response.status, 302);
  assert.match(response.headers.get("Location"), /admin\.html\?login=1/);
});

test("middleware allows an authenticated admin page", async () => {
  const env = { ADMIN_TOKEN: "admin-secret", ADMIN_SESSION_SECRET: "session-secret" };
  const session = await createAdminSession(env);
  const response = await onRequest({
    request: new Request("https://example.com/admin.html", { headers: { Cookie: `emby_admin_session=${session}` } }),
    env,
    next: async () => new Response("ok"),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
});
