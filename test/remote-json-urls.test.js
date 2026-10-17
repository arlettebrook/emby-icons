import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_REMOTE_JSON_URLS,
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
