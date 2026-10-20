import assert from "node:assert/strict";
import test from "node:test";

const storageModuleUrl = new URL("../public/submission-storage.js", import.meta.url);
let caseId = 0;

function createLocalStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
    removeItem(key) {
      values.delete(String(key));
    },
  };
}

function createCloudStorage(initial = {}, { failGet = false, hangGet = false } = {}) {
  const values = new Map(Object.entries(initial));
  const calls = [];
  return {
    values,
    calls,
    getItem(key, callback) {
      calls.push(["getItem", key]);
      if (hangGet) return;
      queueMicrotask(() => {
        if (failGet) callback(new Error("cloud unavailable"), "");
        else callback(null, values.get(key) || "");
      });
    },
    setItem(key, value, callback) {
      calls.push(["setItem", key, value]);
      values.set(String(key), String(value));
      queueMicrotask(() => callback?.(null));
    },
    removeItem(key, callback) {
      calls.push(["removeItem", key]);
      values.delete(String(key));
      queueMicrotask(() => callback?.(null));
    },
  };
}

async function loadStorageModule(localStorage, cloud = null) {
  globalThis.window = {
    localStorage,
    Telegram: cloud ? { WebApp: { CloudStorage: cloud } } : undefined,
  };
  caseId += 1;
  return import(`${storageModuleUrl.href}?case=${caseId}`);
}

function credentials(id, token) {
  return { id, token };
}

test("credentials remain available through localStorage in a plain browser", async () => {
  const localStorage = createLocalStorage();
  const storage = await loadStorageModule(localStorage);

  await storage.saveReferences([credentials("local-1", "token-1")]);

  assert.deepEqual(await storage.loadReferences(), [credentials("local-1", "token-1")]);
  assert.equal(localStorage.getItem("emby-submission-token:local-1"), "token-1");
});

test("load merges device-local credentials with Telegram CloudStorage entries", async () => {
  const localStorage = createLocalStorage({
    "emby-submissions": JSON.stringify([credentials("local-1", "token-1")]),
    "emby-submission-token:local-1": "token-1",
  });
  const cloud = createCloudStorage({
    "emby-submissions": JSON.stringify([credentials("cloud-1", "token-cloud")]),
    "emby-submission-token:cloud-1": "token-cloud",
  });
  const storage = await loadStorageModule(localStorage, cloud);

  assert.deepEqual(await storage.loadReferences(), [
    credentials("local-1", "token-1"),
    credentials("cloud-1", "token-cloud"),
  ]);
  assert.match(localStorage.getItem("emby-submissions"), /cloud-1/);
});

test("a CloudStorage error never hides credentials already stored locally", async () => {
  const localStorage = createLocalStorage({
    "emby-submissions": JSON.stringify([credentials("local-1", "token-1")]),
    "emby-submission-token:local-1": "token-1",
  });
  const cloud = createCloudStorage({}, { failGet: true });
  const storage = await loadStorageModule(localStorage, cloud);

  assert.deepEqual(await storage.loadReferences(), [credentials("local-1", "token-1")]);
});

test("a stalled CloudStorage request falls back to localStorage", async () => {
  const localStorage = createLocalStorage({
    "emby-submissions": JSON.stringify([credentials("local-1", "token-1")]),
    "emby-submission-token:local-1": "token-1",
  });
  const cloud = createCloudStorage({}, { hangGet: true });
  const storage = await loadStorageModule(localStorage, cloud);
  const startedAt = Date.now();

  assert.deepEqual(await storage.loadReferences(), [credentials("local-1", "token-1")]);
  assert.ok(Date.now() - startedAt >= 2400);
});

test("removing a credential clears both local and CloudStorage copies", async () => {
  const localIndex = [
    credentials("keep", "token-keep"),
    credentials("remove", "token-remove"),
  ];
  const cloudIndex = [
    credentials("keep", "token-keep"),
    credentials("remove", "token-remove"),
    credentials("cloud-only", "token-cloud"),
  ];
  const localStorage = createLocalStorage({
    "emby-submissions": JSON.stringify(localIndex),
    "emby-submission-token:keep": "token-keep",
    "emby-submission-token:remove": "token-remove",
  });
  const cloud = createCloudStorage({
    "emby-submissions": JSON.stringify(cloudIndex),
    "emby-submission-token:keep": "token-keep",
    "emby-submission-token:remove": "token-remove",
    "emby-submission-token:cloud-only": "token-cloud",
  });
  const storage = await loadStorageModule(localStorage, cloud);
  await storage.loadReferences();

  const remaining = await storage.removeReference("remove");

  assert.deepEqual(remaining, [
    credentials("keep", "token-keep"),
    credentials("cloud-only", "token-cloud"),
  ]);
  assert.equal(localStorage.getItem("emby-submission-token:remove"), null);
  assert.equal(cloud.values.get("emby-submission-token:remove"), undefined);
  assert.doesNotMatch(cloud.values.get("emby-submissions"), /"remove"/);
  assert.match(cloud.values.get("emby-submissions"), /"keep"/);
});