import assert from "node:assert/strict";
import test from "node:test";

import { createEtag } from "../functions/_shared/icons.js";
import { handleAdminVersionItem, handleAdminVersionList } from "../functions/_shared/versions.js";
import { adminHeaders, createEnvironment } from "./helpers.js";

function addVersion(env, id, document, { createdAt = Date.now(), reason = "test snapshot" } = {}) {
  const text = `${JSON.stringify(document, null, 2)}\n`;
  env.DB.versions.push({
    id,
    document_json: text,
    etag: `"version-${id}"`,
    actor_id: "admin",
    reason,
    created_at: createdAt,
  });
  return text;
}

test("version history requires an admin session", async () => {
  const env = createEnvironment();
  const response = await handleAdminVersionList(
    new Request("https://example.com/api/admin/versions"),
    env,
  );
  assert.equal(response.status, 401);
});

test("version history lists newest snapshots with cursor pagination", async () => {
  const env = createEnvironment({ icons: [{ name: "Current", url: "https://example.com/current.png" }] });
  addVersion(env, 1, { name: "Emby Icons", description: "one", icons: [] }, { createdAt: 1000 });
  addVersion(env, 2, { name: "Emby Icons", description: "two", icons: [] }, { createdAt: 2000 });
  addVersion(env, 3, { name: "Emby Icons", description: "three", icons: [] }, { createdAt: 3000 });

  const first = await handleAdminVersionList(new Request(
    "https://example.com/api/admin/versions?limit=2",
    { headers: adminHeaders() },
  ), env);
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.deepEqual(firstBody.versions.map((version) => version.id), [3, 2]);
  assert.equal(firstBody.nextCursor, "2");

  const second = await handleAdminVersionList(new Request(
    `https://example.com/api/admin/versions?limit=2&cursor=${firstBody.nextCursor}`,
    { headers: adminHeaders() },
  ), env);
  const secondBody = await second.json();
  assert.deepEqual(secondBody.versions.map((version) => version.id), [1]);
  assert.equal(secondBody.nextCursor, null);
});

test("version detail returns its document and the current published ETag", async () => {
  const env = createEnvironment({ icons: [{ name: "Current", url: "https://example.com/current.png" }] });
  const document = { name: "Emby Icons", description: "old", icons: [{ name: "Old", url: "https://example.com/old.png" }] };
  addVersion(env, 9, document);

  const response = await handleAdminVersionItem(new Request(
    "https://example.com/api/admin/versions/9",
    { headers: adminHeaders() },
  ), env, "9");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.version.document, document);
  assert.equal(body.version.iconCount, 1);
  assert.equal(body.currentEtag, await createEtag(env.__kv.get("emby-icons.json")));
});

test("restoring a version snapshots the current document before replacing KV", async () => {
  const env = createEnvironment({ icons: [{ name: "Current", url: "https://example.com/current.png" }] });
  const currentEtag = await createEtag(env.__kv.get("emby-icons.json"));
  const target = {
    name: "Emby Icons",
    description: "Restored",
    icons: [{ name: "Restored", url: "https://example.com/restored.png" }],
  };
  addVersion(env, 4, target);

  const response = await handleAdminVersionItem(new Request(
    "https://example.com/api/admin/versions/4",
    { method: "POST", headers: adminHeaders(), body: JSON.stringify({ action: "restore", expectedEtag: currentEtag }) },
  ), env, "4");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.restored, true);
  assert.equal(body.count, 1);
  assert.equal(response.headers.get("ETag"), body.etag);
  assert.deepEqual(JSON.parse(env.__kv.get("emby-icons.json")), target);

  const beforeRestore = env.DB.versions.find((version) => version.reason === "before-restore:4");
  assert.ok(beforeRestore);
  assert.equal(JSON.parse(beforeRestore.document_json).icons[0].name, "Current");
  assert.ok(env.DB.auditLogs.some((entry) => entry.action === "document-version-restored"));
  assert.equal(env.DB.locks.has("canonical"), false);
});

test("restoring requires an ETag when a document is currently published", async () => {
  const env = createEnvironment({ icons: [{ name: "Current", url: "https://example.com/current.png" }] });
  addVersion(env, 5, { name: "Emby Icons", description: "old", icons: [] });
  const original = env.__kv.get("emby-icons.json");

  const response = await handleAdminVersionItem(new Request(
    "https://example.com/api/admin/versions/5",
    { method: "POST", headers: adminHeaders(), body: JSON.stringify({ action: "restore" }) },
  ), env, "5");
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "ETAG_REQUIRED");
  assert.equal(env.__kv.get("emby-icons.json"), original);
});

test("restoring refuses to overwrite a newer published document", async () => {
  const env = createEnvironment({ icons: [{ name: "Current", url: "https://example.com/current.png" }] });
  const target = { name: "Emby Icons", description: "old", icons: [] };
  addVersion(env, 2, target);
  const original = env.__kv.get("emby-icons.json");

  const response = await handleAdminVersionItem(new Request(
    "https://example.com/api/admin/versions/2",
    { method: "POST", headers: adminHeaders(), body: JSON.stringify({ action: "restore", expectedEtag: "\"stale\"" }) },
  ), env, "2");
  assert.equal(response.status, 412);
  assert.equal((await response.json()).code, "ETAG_MISMATCH");
  assert.equal(env.__kv.get("emby-icons.json"), original);
});

test("restoring rejects a version with duplicate normalized icon names", async () => {
  const env = createEnvironment();
  addVersion(env, 3, {
    name: "Emby Icons",
    description: "",
    icons: [
      { name: "Same", url: "https://example.com/1.png" },
      { name: " same ", url: "https://example.com/2.png" },
    ],
  });

  const response = await handleAdminVersionItem(new Request(
    "https://example.com/api/admin/versions/3",
    { method: "POST", headers: adminHeaders(), body: JSON.stringify({ action: "restore" }) },
  ), env, "3");
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "ICON_NAME_CONFLICT");
});