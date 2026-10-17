import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  MAX_REMOTE_JSON_URLS,
  MAX_REMOTE_JSON_URL_NOTE_LENGTH,
  REMOTE_JSON_URLS_KEY,
  handleAdminRemoteJsonUrlCollection,
  handleAdminRemoteJsonUrlItem,
  handleRemoteJsonUrlOptions,
} from "../functions/_shared/remote-json-urls.js";

import {
  onRequestGet as onCollectionGet,
  onRequestPost as onCollectionPost,
  onRequestOptions as onCollectionOptions,
} from "../functions/api/admin/remote-json-urls.js";
import {
  onRequestGet as onItemGet,
  onRequestPut as onItemPut,
  onRequestDelete as onItemDelete,
  onRequestOptions as onItemOptions,
} from "../functions/api/admin/remote-json-urls/[id].js";
import { adminHeaders, createEnvironment } from "./helpers.js";

function collectionRequest(method = "GET", body, headers = adminHeaders()) {
  return new Request("https://example.com/api/admin/remote-json-urls", {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function itemRequest(id, method = "GET", body, headers = adminHeaders()) {
  return new Request(`https://example.com/api/admin/remote-json-urls/${id}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("remote JSON URL endpoints require an admin session", async () => {
  const env = createEnvironment();
  const response = await handleAdminRemoteJsonUrlCollection(
    collectionRequest("GET", undefined, { "Content-Type": "application/json" }),
    env,
  );
  assert.equal(response.status, 401);
  assert.equal(await env.__kv.get(REMOTE_JSON_URLS_KEY), undefined);
});

test("admin can create, list, read, update, and delete saved remote JSON URLs", async () => {
  const env = createEnvironment();

  const createdResponse = await handleAdminRemoteJsonUrlCollection(
    collectionRequest("POST", { url: "  https://Example.COM/icons/emby.json  " }),
    env,
  );
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.item.url, "https://example.com/icons/emby.json");
  assert.equal(created.item.note, "");
  assert.equal(typeof created.item.id, "string");
  assert.equal(created.item.createdAt, created.item.updatedAt);
  assert.equal(created.count, 1);

  const stored = JSON.parse(env.__kv.get(REMOTE_JSON_URLS_KEY));
  assert.equal(stored.version, 1);
  assert.deepEqual(stored.items, [created.item]);

  const listResponse = await handleAdminRemoteJsonUrlCollection(collectionRequest(), env);
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.deepEqual(list.items, [created.item]);

  const readResponse = await handleAdminRemoteJsonUrlItem(itemRequest(created.item.id), env, created.item.id);
  assert.equal(readResponse.status, 200);
  assert.deepEqual((await readResponse.json()).item, created.item);

  const updatedResponse = await handleAdminRemoteJsonUrlItem(
    itemRequest(created.item.id, "PUT", { url: "https://cdn.example.com/emby-icons.json" }),
    env,
    created.item.id,
  );
  assert.equal(updatedResponse.status, 200);
  const updated = (await updatedResponse.json()).item;
  assert.equal(updated.id, created.item.id);
  assert.equal(updated.url, "https://cdn.example.com/emby-icons.json");
  assert.equal(updated.note, "");
  assert.equal(updated.createdAt, created.item.createdAt);
  assert.ok(updated.updatedAt >= created.item.updatedAt);

  const deleteResponse = await handleAdminRemoteJsonUrlItem(
    itemRequest(created.item.id, "DELETE"),
    env,
    created.item.id,
  );
  assert.equal(deleteResponse.status, 200);
  assert.equal((await deleteResponse.json()).id, created.item.id);
  assert.deepEqual(JSON.parse(env.__kv.get(REMOTE_JSON_URLS_KEY)).items, []);

  const emptyList = await handleAdminRemoteJsonUrlCollection(collectionRequest(), env);
  assert.deepEqual((await emptyList.json()).items, []);
});

test("remote JSON URL storage rejects invalid, private, and duplicate addresses", async () => {
  const env = createEnvironment();
  const invalidUrls = [
    "javascript:alert(1)",
    "https://user:password@example.com/icons.json",
    "http://127.0.0.1/icons.json",
    "https://example.com:8080/icons.json",
    "not a url",
  ];
  for (const url of invalidUrls) {
    const response = await handleAdminRemoteJsonUrlCollection(collectionRequest("POST", { url }), env);
    assert.equal(response.status, 400, url);
  }

  const first = await handleAdminRemoteJsonUrlCollection(
    collectionRequest("POST", { url: "https://example.com/icons.json" }),
    env,
  );
  assert.equal(first.status, 201);

  const duplicate = await handleAdminRemoteJsonUrlCollection(
    collectionRequest("POST", { url: "https://EXAMPLE.com/icons.json" }),
    env,
  );
  assert.equal(duplicate.status, 409);
});

test("remote JSON URL updates cannot duplicate another saved address", async () => {
  const env = createEnvironment();
  const first = await handleAdminRemoteJsonUrlCollection(
    collectionRequest("POST", { url: "https://example.com/first.json" }),
    env,
  ).then((response) => response.json());
  const second = await handleAdminRemoteJsonUrlCollection(
    collectionRequest("POST", { url: "https://example.com/second.json" }),
    env,
  ).then((response) => response.json());

  const response = await handleAdminRemoteJsonUrlItem(
    itemRequest(second.item.id, "PUT", { url: first.item.url }),
    env,
    second.item.id,
  );
  assert.equal(response.status, 409);
});

test("saved remote JSON URL notes can be added, changed, preserved, and cleared", async () => {
  const env = createEnvironment();
  const created = await handleAdminRemoteJsonUrlCollection(
    collectionRequest("POST", { url: "  https://Example.COM/library.json  ", note: "  LiangYou 图标库  " }),
    env,
  ).then((response) => response.json());
  assert.equal(created.item.note, "LiangYou 图标库");
  assert.deepEqual(JSON.parse(env.__kv.get(REMOTE_JSON_URLS_KEY)).items, [created.item]);

  const listed = await handleAdminRemoteJsonUrlCollection(collectionRequest(), env).then((response) => response.json());
  assert.equal(listed.items[0].note, "LiangYou 图标库");

  const renamed = await handleAdminRemoteJsonUrlItem(
    itemRequest(created.item.id, "PUT", { url: created.item.url, note: "  新备注  " }),
    env,
    created.item.id,
  ).then((response) => response.json());
  assert.equal(renamed.item.note, "新备注");

  const urlOnly = await handleAdminRemoteJsonUrlItem(
    itemRequest(created.item.id, "PUT", { url: "https://cdn.example.com/library.json" }),
    env,
    created.item.id,
  ).then((response) => response.json());
  assert.equal(urlOnly.item.note, "新备注");

  const cleared = await handleAdminRemoteJsonUrlItem(
    itemRequest(created.item.id, "PUT", { url: urlOnly.item.url, note: "   " }),
    env,
    created.item.id,
  ).then((response) => response.json());
  assert.equal(cleared.item.note, "");
});

test("saved remote JSON URL notes enforce type and length limits", async () => {
  const env = createEnvironment();
  const url = "https://example.com/library.json";

  for (const note of [42, true, ["note"], { text: "note" }]) {
    const response = await handleAdminRemoteJsonUrlCollection(collectionRequest("POST", { url, note }), env);
    assert.equal(response.status, 400, String(note));
  }

  const tooLong = await handleAdminRemoteJsonUrlCollection(
    collectionRequest("POST", { url, note: "图".repeat(MAX_REMOTE_JSON_URL_NOTE_LENGTH + 1) }),
    env,
  );
  assert.equal(tooLong.status, 400);

  const maxLength = await handleAdminRemoteJsonUrlCollection(
    collectionRequest("POST", { url, note: "图".repeat(MAX_REMOTE_JSON_URL_NOTE_LENGTH) }),
    env,
  );
  assert.equal(maxLength.status, 201);
  const created = await maxLength.json();
  assert.equal(Array.from(created.item.note).length, MAX_REMOTE_JSON_URL_NOTE_LENGTH);
});

test("legacy saved remote JSON URLs without notes remain readable", async () => {
  const env = createEnvironment();
  await env.EMBY_ICONS.put(REMOTE_JSON_URLS_KEY, JSON.stringify({
    version: 1,
    updatedAt: 1,
    items: [{
      id: "legacy-id",
      url: "https://example.com/legacy.json",
      createdAt: 1,
      updatedAt: 1,
    }],
  }));

  const response = await handleAdminRemoteJsonUrlCollection(collectionRequest(), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.items[0].note, "");
});

test("admin import UI exposes note editing and direct saved-address fetch controls", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../public/admin.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="remote-note"/);
  assert.match(html, /maxlength="100"/);
  assert.match(script, /function fetchSavedRemoteJson\(/);
  assert.match(script, /fetchRemoteJson\(triggerButton, item\.url, item\.note\)/);
  assert.doesNotMatch(script, /useSavedRemoteUrl\(item\);\s*await fetchRemoteJson/);
  assert.doesNotMatch(script, /elements\.remoteUrl\.value = savedRemoteUrls\[0\]/);
  assert.match(script, /remote-history-action remote-history-fetch/);
});

test("admin import UI clears address inputs after updating or cancelling an edit", async () => {
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(
    script,
    /function resetRemoteEditor\(\{ clearInputs = true \} = \{\}\) \{\s*editingRemoteUrlId = null;\s*if \(clearInputs\) \{\s*elements\.remoteUrl\.value = "";\s*elements\.remoteNote\.value = "";/,
  );
  assert.match(script, /resetRemoteEditor\(\);\s*showToast\("已更新远程 JSON 地址"\)/);
  assert.match(script, /remoteEditCancel\.addEventListener\("click", \(\) => \{\s*resetRemoteEditor\(\);/);
});

test("admin import UI distinguishes fetched JSON from manual input", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../public/admin.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="import-source-status"/);
  assert.match(html, /id="import-source-clear"/);
  assert.match(html, /JSON 内容 <small class="field-optional">远程获取或手动粘贴<\/small>/);
  assert.doesNotMatch(html, />粘贴 JSON</);
  assert.match(script, /function showImportSourceStatus\(/);
  assert.match(script, /内容已填入下方“JSON 内容”/);
});

test("unknown remote JSON URL ids return 404", async () => {
  const env = createEnvironment();
  for (const method of ["GET", "PUT", "DELETE"]) {
    const response = await handleAdminRemoteJsonUrlItem(
      itemRequest("missing", method, method === "PUT" ? { url: "https://example.com/icons.json" } : undefined),
      env,
      "missing",
    );
    assert.equal(response.status, 404, method);
  }
});

test("remote JSON URL storage enforces the saved address limit", async () => {
  const env = createEnvironment();
  const items = Array.from({ length: MAX_REMOTE_JSON_URLS }, (_, index) => ({
    id: `id-${index}`,
    url: `https://example.com/icons-${index}.json`,
    createdAt: index + 1,
    updatedAt: index + 1,
  }));
  await env.EMBY_ICONS.put(REMOTE_JSON_URLS_KEY, JSON.stringify({ version: 1, updatedAt: 1, items }));

  const response = await handleAdminRemoteJsonUrlCollection(
    collectionRequest("POST", { url: "https://example.com/overflow.json" }),
    env,
  );
  assert.equal(response.status, 409);
});

test("remote JSON URL OPTIONS advertises admin CRUD methods", async () => {
  const response = handleRemoteJsonUrlOptions(
    new Request("https://example.com/api/admin/remote-json-urls", {
      method: "OPTIONS",
      headers: { Origin: "https://example.com" },
    }),
  );
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://example.com");
  assert.match(response.headers.get("Access-Control-Allow-Methods"), /GET, POST, PUT, DELETE, OPTIONS/);
});

test("admin remote JSON route modules expose the expected Pages handlers", () => {
  for (const handler of [
    onCollectionGet,
    onCollectionPost,
    onCollectionOptions,
    onItemGet,
    onItemPut,
    onItemDelete,
    onItemOptions,
  ]) {
    assert.equal(typeof handler, "function");
  }
});

test("saved remote JSON URL list supports ETag revalidation", async () => {
  const env = createEnvironment();
  const createdResponse = await handleAdminRemoteJsonUrlCollection(
    collectionRequest("POST", { url: "https://example.com/etag-icons.json", note: "ETag" }),
    env,
  );
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.ok(createdResponse.headers.get("ETag"));

  const first = await handleAdminRemoteJsonUrlCollection(collectionRequest(), env);
  assert.equal(first.status, 200);
  const etag = first.headers.get("ETag");
  assert.ok(etag);
  assert.equal(first.headers.get("Access-Control-Expose-Headers"), "ETag");
  await first.json();

  const revalidated = await handleAdminRemoteJsonUrlCollection(
    collectionRequest("GET", undefined, adminHeaders({ "If-None-Match": etag })),
    env,
  );
  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.headers.get("ETag"), etag);
  assert.equal(await revalidated.text(), "");

  await handleAdminRemoteJsonUrlItem(
    itemRequest(created.item.id, "PUT", { url: created.item.url, note: "Changed" }),
    env,
    created.item.id,
  );
  const changed = await handleAdminRemoteJsonUrlCollection(collectionRequest(), env);
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get("ETag"), etag);
});

test("admin import UI reuses the saved-address cache and delegates history actions", async () => {
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(script, /If-None-Match/);
  assert.match(script, /REMOTE_URLS_FRESH_MS/);
  assert.match(script, /remoteHistoryList\.addEventListener\("click"/);
  assert.match(script, /normalizeImportedIcons\(body\.value\)/);
  assert.doesNotMatch(script, /parseImportedIcons\(JSON\.stringify\(body\.value\)\)/);
});
