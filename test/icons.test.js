import assert from "node:assert/strict";
import test from "node:test";

import { handleGet, handlePut } from "../functions/_shared/icons.js";

const seed = {
  name: "Emby Icons",
  description: "Test",
  icons: [{ name: "Demo", url: "https://example.com/demo.png" }],
};

function createEnvironment() {
  const values = new Map();
  return {
    ADMIN_TOKEN: "secret-token",
    ASSETS: {
      fetch: async () => new Response(JSON.stringify(seed)),
    },
    EMBY_ICONS: {
      get: async (key) => values.get(key) ?? null,
      put: async (key, value) => values.set(key, value),
    },
  };
}

test("GET falls back to the seed document", async () => {
  const response = await handleGet(new Request("https://example.com/api/icons"), createEnvironment());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Emby-Icons-Source"), "seed");
  assert.deepEqual(await response.json(), seed);
});

test("PUT requires the admin token", async () => {
  const request = new Request("https://example.com/api/icons", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(seed),
  });
  const response = await handlePut(request, createEnvironment());
  assert.equal(response.status, 401);
});

test("PUT validates and persists a document", async () => {
  const env = createEnvironment();
  const updated = { ...seed, icons: [...seed.icons, { name: "Second", url: "https://example.com/2.png" }] };
  const request = new Request("https://example.com/api/icons", {
    method: "PUT",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(updated),
  });

  const response = await handlePut(request, env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).count, 2);

  const stored = await handleGet(new Request("https://example.com/api/icons"), env);
  assert.equal(stored.headers.get("X-Emby-Icons-Source"), "kv");
  assert.deepEqual(await stored.json(), updated);
});

test("PUT ignores accidental whitespace around the configured secret", async () => {
  const env = createEnvironment();
  env.ADMIN_TOKEN = "  secret-token\n";
  const request = new Request("https://example.com/api/icons", {
    method: "PUT",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(seed),
  });

  const response = await handlePut(request, env);
  assert.equal(response.status, 200);
});

test("PUT rejects invalid icon URLs", async () => {
  const env = createEnvironment();
  const invalid = { ...seed, icons: [{ name: "Bad", url: "javascript:alert(1)" }] };
  const request = new Request("https://example.com/api/icons", {
    method: "PUT",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(invalid),
  });

  const response = await handlePut(request, env);
  assert.equal(response.status, 400);
});
