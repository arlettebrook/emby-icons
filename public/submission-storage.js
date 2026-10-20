const INDEX_KEY = "emby-submissions";
const TOKEN_PREFIX = "emby-submission-token:";
const MAX_REFERENCES = 30;
const CLOUD_TIMEOUT_MS = 2500;

let cachedCloudReferences = null;
let cachedCloudFingerprint = "";

function getLocalStorage() {
  try {
    return window.localStorage || null;
  } catch {
    return null;
  }
}

function tokenStorageKey(id) {
  return TOKEN_PREFIX + id;
}

function normalizeReferences(values) {
  const seen = new Set();
  const references = [];
  for (const item of Array.isArray(values) ? values : []) {
    const id = typeof item === "string" ? item : String(item?.id || "").trim();
    const token = typeof item === "string" ? "" : String(item?.token || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    references.push({ id, token });
    if (references.length >= MAX_REFERENCES) break;
  }
  return references;
}

export function readLocalReferences() {
  const storage = getLocalStorage();
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(INDEX_KEY) || "[]");
    const references = normalizeReferences(
      Array.isArray(parsed) ? parsed.filter((item) => item?.id && item?.token) : [],
    );
    const known = new Set(references.map((item) => item.id));
    for (let index = 0; index < storage.length && references.length < MAX_REFERENCES; index += 1) {
      const key = storage.key(index) || "";
      if (!key.startsWith(TOKEN_PREFIX)) continue;
      const id = key.slice(TOKEN_PREFIX.length);
      const token = storage.getItem(key) || "";
      if (id && token && !known.has(id)) {
        known.add(id);
        references.push({ id, token });
      }
    }
    return references;
  } catch {
    return [];
  }
}

function persistLocalReferences(references) {
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(INDEX_KEY, JSON.stringify(references));
    for (const reference of references) {
      storage.setItem(tokenStorageKey(reference.id), reference.token);
    }
    // Token keys are also a legacy index. Remove keys that no longer belong to
    // the active set so readLocalReferences() cannot resurrect a deleted entry.
    const active = new Set(references.map((reference) => reference.id));
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index) || "";
      if (key.startsWith(TOKEN_PREFIX) && !active.has(key.slice(TOKEN_PREFIX.length))) {
        storage.removeItem(key);
      }
    }
  } catch {
    // Private mode or a full quota: CloudStorage may still succeed.
  }
}

function getCloudStorage() {
  try {
    return window.Telegram?.WebApp?.CloudStorage || null;
  } catch {
    return null;
  }
}

function cloudRequest(method, ...args) {
  const cloud = getCloudStorage();
  if (!cloud || typeof cloud[method] !== "function") {
    return Promise.resolve({ supported: false, value: null });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ supported: true, value: null, timedOut: true }), CLOUD_TIMEOUT_MS);
    try {
      cloud[method](...args, (error, value) => {
        finish({
          supported: true,
          error: error || null,
          value: value === undefined ? null : value,
        });
      });
    } catch (error) {
      finish({ supported: true, error, value: null });
    }
  });
}

function fingerprint(references) {
  return JSON.stringify(references.map((item) => [item.id, item.token]).sort((left, right) => left[0].localeCompare(right[0])));
}

function parseCloudIndex(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return normalizeReferences(Array.isArray(parsed) ? parsed : []);
  } catch {
    return [];
  }
}

async function readCloudReferences() {
  const indexResult = await cloudRequest("getItem", INDEX_KEY);
  if (!indexResult.supported || indexResult.error) return [];
  const references = parseCloudIndex(indexResult.value);
  if (!references.length) return [];

  // Older indexes only stored IDs. Fill missing tokens from the per-record keys.
  const missing = references.filter((item) => !item.token);
  if (!missing.length) return references;
  const tokens = await Promise.all(
    missing.map(async (item) => {
      const result = await cloudRequest("getItem", tokenStorageKey(item.id));
      return result.error ? "" : String(result.value || "").trim();
    }),
  );
  const tokenById = new Map(missing.map((item, index) => [item.id, tokens[index]]));
  return references
    .map((item) => ({ id: item.id, token: item.token || tokenById.get(item.id) || "" }))
    .filter((item) => item.token);
}

async function syncCloudReferences(references) {
  const cloud = getCloudStorage();
  if (!cloud) return;
  const normalized = normalizeReferences(references);
  const nextFingerprint = fingerprint(normalized);
  if (cachedCloudReferences !== null && nextFingerprint === cachedCloudFingerprint) return;

  await Promise.allSettled(
    normalized.map((item) => cloudRequest("setItem", tokenStorageKey(item.id), item.token)),
  );
  const indexResult = await cloudRequest("setItem", INDEX_KEY, JSON.stringify(normalized));
  if (!indexResult.error) {
    cachedCloudReferences = normalized;
    cachedCloudFingerprint = nextFingerprint;
  }
}

function mergeReferences(local, cloud) {
  const merged = [];
  const seen = new Set();
  for (const item of [...local, ...cloud]) {
    if (!item?.id || !item?.token || seen.has(item.id) || merged.length >= MAX_REFERENCES) continue;
    seen.add(item.id);
    merged.push({ id: item.id, token: item.token });
  }
  return merged;
}

export async function loadReferences() {
  const local = readLocalReferences();
  let cloud = [];
  try {
    cloud = await readCloudReferences();
  } catch {
    cloud = [];
  }
  cachedCloudReferences = cloud;
  cachedCloudFingerprint = fingerprint(cloud);
  const merged = mergeReferences(local, cloud);
  // Persist the union locally without waiting for CloudStorage writes.
  if (merged.length !== local.length) persistLocalReferences(merged);
  return merged;
}

export async function saveReferences(values) {
  const references = normalizeReferences(values).filter((item) => item.token);
  if (!references.length) return readLocalReferences();
  persistLocalReferences(references);
  try {
    await syncCloudReferences(references);
  } catch {
    // localStorage already holds the credentials; CloudStorage is best-effort.
  }
  return references;
}

export async function addReference(id, token) {
  const normalizedId = String(id || "").trim();
  const normalizedToken = String(token || "").trim();
  if (!normalizedId || !normalizedToken) return readLocalReferences();
  const local = normalizeReferences(
    [{ id: normalizedId, token: normalizedToken }, ...readLocalReferences().filter((item) => item.id !== normalizedId)],
  );
  // Write synchronously so a fast page close cannot lose the new credential.
  persistLocalReferences(local);
  const merged = await loadReferences();
  persistLocalReferences(merged);
  await saveReferences(merged);
  return merged;
}

async function removeReferenceSet(ids) {
  const wanted = new Set(Array.from(ids, (id) => String(id || "")).filter(Boolean));
  if (!wanted.size) return readLocalReferences();
  const local = readLocalReferences().filter((item) => !wanted.has(item.id));
  persistLocalReferences(local);

  let cloud = cachedCloudReferences;
  if (cloud === null) {
    try {
      cloud = await readCloudReferences();
    } catch {
      cloud = [];
    }
  }
  const nextCloud = (cloud || []).filter((item) => !wanted.has(item.id));
  await Promise.allSettled(
    [...wanted].map((id) => cloudRequest("removeItem", tokenStorageKey(id))),
  );
  const indexResult = await cloudRequest("setItem", INDEX_KEY, JSON.stringify(nextCloud));
  if (!indexResult.error) {
    cachedCloudReferences = nextCloud;
    cachedCloudFingerprint = fingerprint(nextCloud);
  } else {
    cachedCloudReferences = null;
  }
  return readLocalReferences();
}

export function removeReference(id) {
  return removeReferenceSet([id]);
}

export function removeReferences(ids) {
  return removeReferenceSet(ids);
}

// Small callback-compatible helpers keep this module usable outside the two
// submission pages without duplicating the CloudStorage fallback rules.
export function getItem(key, callback) {
  const storage = getLocalStorage();
  let localValue = null;
  try {
    localValue = storage ? storage.getItem(key) : null;
  } catch {
    localValue = null;
  }
  if (localValue !== null) {
    if (typeof callback === "function") queueMicrotask(() => callback(null, localValue));
    return localValue;
  }
  cloudRequest("getItem", key).then((result) => {
    if (typeof callback !== "function") return;
    if (result.error) callback(result.error, "");
    else callback(null, result.value || "");
  });
  return null;
}

export function setItem(key, value, callback) {
  const storage = getLocalStorage();
  try {
    storage?.setItem(key, value);
  } catch {
    // CloudStorage is still attempted below.
  }
  cloudRequest("setItem", key, value).then((result) => {
    if (typeof callback === "function") callback(result.error || null);
  });
}

export function removeItem(key, callback) {
  const storage = getLocalStorage();
  try {
    storage?.removeItem(key);
  } catch {
    // CloudStorage is still attempted below.
  }
  cloudRequest("removeItem", key).then((result) => {
    if (typeof callback === "function") callback(result.error || null);
  });
}