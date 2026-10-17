import assert from "node:assert/strict";
import test from "node:test";

import { onRequestPost } from "../functions/api/import.js";

test("remote import requires the admin token", async () => {
  const response = await onRequestPost({
    request: new Request("https://example.com/api/import", {
      method: "POST",
      body: JSON.stringify({ url: "https://example.org/icons.json" }),
    }),
    env: { ADMIN_TOKEN: "secret" },
  });
  assert.equal(response.status, 401);
});

test("remote import fetches JSON on the server", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url.href, "https://example.org/icons.json");
    return new Response(JSON.stringify({ icons: [{ name: "Demo", url: "https://example.org/demo.png" }] }), {
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const response = await onRequestPost({
      request: new Request("https://example.com/api/import", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.org/icons.json" }),
      }),
      env: { ADMIN_TOKEN: "secret" },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).value.icons[0].name, "Demo");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("remote import blocks private hosts", async () => {
  const response = await onRequestPost({
    request: new Request("https://example.com/api/import", {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1/icons.json" }),
    }),
    env: { ADMIN_TOKEN: "secret" },
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /private|local/i);
});

test("remote import coalesces concurrent requests and reuses the short-lived cache", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    assert.equal(url.href, "https://cached.example.org/icons.json");
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify({ icons: [{ name: "Cached", url: "https://cached.example.org/cached.png" }] }), {
      headers: { "Content-Type": "application/json" },
    });
  };

  const makeRequest = () => new Request("https://example.com/api/import", {
    method: "POST",
    headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://cached.example.org/icons.json" }),
  });
  try {
    const [first, second] = await Promise.all([
      onRequestPost({ request: makeRequest(), env: { ADMIN_TOKEN: "secret" } }),
      onRequestPost({ request: makeRequest(), env: { ADMIN_TOKEN: "secret" } }),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(calls, 1);
    assert.equal((await first.json()).value.icons[0].name, "Cached");

    const third = await onRequestPost({ request: makeRequest(), env: { ADMIN_TOKEN: "secret" } });
    assert.equal(third.status, 200);
    assert.equal((await third.json()).value.icons[0].name, "Cached");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
