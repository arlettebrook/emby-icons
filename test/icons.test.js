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

test("GET does not fall back to repository seed data", async () => {
  const response = await handleGet(new Request("https://example.com/api/icons"), createEnvironment());
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("X-Emby-Icons-Source"), "kv");
  assert.match((await response.json()).error, /KV/);
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

test("PUT rejects stale ETags when the KV document changed", async () => {
  const env = createEnvironment();
  const initialWrite = new Request("https://example.com/api/icons", {
    method: "PUT",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(seed),
  });
  assert.equal((await handlePut(initialWrite, env)).status, 200);
  const initial = await handleGet(new Request("https://example.com/api/icons"), env);
  const staleEtag = initial.headers.get("ETag");

  const newer = { ...seed, description: "Updated remotely" };
  const remoteUpdate = new Request("https://example.com/api/icons", {
    method: "PUT",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(newer),
  });
  assert.equal((await handlePut(remoteUpdate, env)).status, 200);

  const staleUpdate = new Request("https://example.com/api/icons", {
    method: "PUT",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
      "If-Match": staleEtag,
    },
    body: JSON.stringify(seed),
  });
  const response = await handlePut(staleUpdate, env);
  assert.equal(response.status, 412);
  assert.match((await response.json()).error, /changed/);
});

test("PUT allows an authenticated force overwrite after a stale ETag", async () => {
  const env = createEnvironment();
  const first = new Request("https://example.com/api/icons", {
    method: "PUT",
    headers: { Authorization: "Bearer secret-token", "Content-Type": "application/json" },
    body: JSON.stringify(seed),
  });
  await handlePut(first, env);
  const initial = await handleGet(new Request("https://example.com/api/icons"), env);
  const staleEtag = initial.headers.get("ETag");

  const newer = { ...seed, description: "Remote update" };
  await handlePut(new Request("https://example.com/api/icons", {
    method: "PUT",
    headers: { Authorization: "Bearer secret-token", "Content-Type": "application/json" },
    body: JSON.stringify(newer),
  }), env);

  const overwrite = { ...seed, description: "My update" };
  const response = await handlePut(new Request("https://example.com/api/icons", {
    method: "PUT",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
      "If-Match": staleEtag,
      "X-Force-Overwrite": "true",
    },
    body: JSON.stringify(overwrite),
  }), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await (await handleGet(new Request("https://example.com/api/icons"), env)).json(), overwrite);
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
