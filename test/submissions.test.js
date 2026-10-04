import assert from "node:assert/strict";
import test from "node:test";

import {
  handleAdminSubmissionDecision,
  handleAdminSubmissionList,
  handleSubmissionCreate,
  handleSubmissionItem,
} from "../functions/_shared/submissions.js";

class FakeD1 {
  constructor() {
    this.submissions = new Map();
    this.locks = new Map();
    this.auditLogs = [];
    this.versions = [];
    this.approvalUpdateFailures = 0;
  }

  prepare(sql) {
    const text = sql.replace(/\s+/g, " ").trim();
    const db = this;
    const statement = (values) => ({
        first: async () => {
          if (text.startsWith("SELECT COUNT(*)")) {
            const [ipHash, cutoff] = values;
            return {
              count: [...db.submissions.values()].filter(
                (row) => row.ip_hash === ipHash && row.created_at >= cutoff && row.status !== "withdrawn",
              ).length,
            };
          }
          if (text.startsWith("SELECT id, name, url, note, status")) {
            return db.submissions.get(values[0]) || null;
          }
          if (text.startsWith("SELECT owner FROM document_publish_lock")) {
            const lock = db.locks.get("canonical");
            return lock ? { owner: lock.owner } : null;
          }
          return null;
        },
        all: async () => {
          if (text.includes("FROM submissions")) {
            const scoped = text.includes("WHERE status = ?1");
            const status = scoped ? values[0] : null;
            const limit = scoped ? values[1] : values[0];
            const rows = [...db.submissions.values()]
              .filter((row) => (status ? row.status === status : true))
              .sort((a, b) => b.created_at - a.created_at)
              .slice(0, limit);
            return { results: rows };
          }
          return { results: [] };
        },
        run: async () => {
          if (text.startsWith("INSERT INTO submissions")) {
            const [id, name, url, note, tokenHash, ipHash, createdAt] = values;
            db.submissions.set(id, {
              id,
              name,
              url,
              note,
              status: "pending",
              submitter_token_hash: tokenHash,
              ip_hash: ipHash,
              created_at: createdAt,
              reviewer_id: null,
              reviewer_note: null,
              reviewed_at: null,
            });
            return { meta: { changes: 1 } };
          }
          if (text.startsWith("UPDATE submissions SET status = 'withdrawn'")) {
            const row = db.submissions.get(values[0]);
            if (row && row.status === "pending") {
              row.status = "withdrawn";
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (text.startsWith("UPDATE submissions SET name = ?1, url = ?2, note = ?3")) {
            const [name, url, note, id] = values;
            const row = db.submissions.get(id);
            if (row && row.status === "pending") {
              row.name = name;
              row.url = url;
              row.note = note;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (text.startsWith("UPDATE submissions SET status = 'rejected'")) {
            const [reviewerId, note, reviewedAt, id] = values;
            const row = db.submissions.get(id);
            if (row && row.status === "pending") {
              row.status = "rejected";
              row.reviewer_id = reviewerId;
              row.reviewer_note = note;
              row.reviewed_at = reviewedAt;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (text === "UPDATE submissions SET status = 'approving' WHERE id = ?1 AND status = 'pending'") {
            const row = db.submissions.get(values[0]);
            if (row && row.status === "pending") {
              row.status = "approving";
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (text === "UPDATE submissions SET status = 'pending' WHERE id = ?1 AND status = 'approving'") {
            const row = db.submissions.get(values[0]);
            if (row && row.status === "approving") {
              row.status = "pending";
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (text.startsWith("UPDATE submissions SET status = 'approved'")) {
            if (db.approvalUpdateFailures > 0) {
              db.approvalUpdateFailures -= 1;
              throw new Error("D1 approval write failed");
            }
            const [name, reviewerId, reviewedAt, id] = values;
            const row = db.submissions.get(id);
            if (row && (row.status === "approving" || row.status === "pending")) {
              row.status = "approved";
              row.name = name;
              row.reviewer_id = reviewerId;
              row.reviewed_at = reviewedAt;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (text.startsWith("INSERT INTO document_publish_lock")) {
            const [owner, expiresAt, now] = values;
            const existing = db.locks.get("canonical");
            if (!existing || existing.expires_at < now) {
              db.locks.set("canonical", { owner, expires_at: expiresAt });
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (text.startsWith("DELETE FROM document_publish_lock")) {
            const lock = db.locks.get("canonical");
            if (lock && lock.owner === values[0]) {
              db.locks.delete("canonical");
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (text.startsWith("INSERT INTO audit_logs")) {
            const [actorId, action, targetId, detailsJson, createdAt] = values;
            db.auditLogs.push({ actorId, action, targetId, detailsJson, createdAt });
            return { meta: { changes: 1 } };
          }
          if (text.startsWith("INSERT INTO document_versions")) {
            db.versions.push(values);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        },
      });
    const prepared = statement([]);
    prepared.bind = (...values) => statement(values);
    return prepared;
  }
}

function createEnvironment({ icons = [], kvUnavailable = false } = {}) {
  const values = new Map();
  const document = { name: "Emby Icons", description: "Test", icons };
  values.set("emby-icons.json", `${JSON.stringify(document, null, 2)}\n`);
  const env = {
    DB: new FakeD1(),
    ADMIN_TOKEN: "admin-secret",
    SUBMISSION_HASH_SECRET: "test-secret",
    EMBY_ICONS: {
      get: async (key) => (kvUnavailable ? null : values.get(key) ?? null),
      put: async (key, value) => {
        values.set(key, value);
      },
    },
    __kv: values,
  };
  return env;
}

function readKv(env) {
  return JSON.parse(env.__kv.get("emby-icons.json"));
}

function adminHeaders(extra = {}) {
  return { Authorization: "Bearer admin-secret", "Content-Type": "application/json", ...extra };
}

async function createSubmission(env, name, url) {
  const response = await handleSubmissionCreate(
    new Request("https://example.com/api/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, url }),
    }),
    env,
  );
  const body = await response.json();
  return body.submission.id;
}

async function decide(env, id, payload) {
  return handleAdminSubmissionDecision(
    new Request(`https://example.com/api/admin/submissions/${id}`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify(payload),
    }),
    env,
    id,
  );
}

test("public submission validates HTTPS URLs and returns a private access token", async () => {
  const env = createEnvironment();
  const response = await handleSubmissionCreate(
    new Request("https://example.com/api/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.10" },
      body: JSON.stringify({ name: "Demo", url: "https://example.com/demo.png" }),
    }),
    env,
  );

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.submission.status, "pending");
  assert.equal(typeof body.accessToken, "string");
  assert.equal(env.DB.submissions.size, 1);
  assert.notEqual([...env.DB.submissions.values()][0].submitter_token_hash, body.accessToken);
});

test("public submission rejects HTTP and script URLs", async () => {
  const env = createEnvironment();
  for (const url of ["http://example.com/icon.png", "javascript:alert(1)"]) {
    const response = await handleSubmissionCreate(
      new Request("https://example.com/api/submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Bad", url }),
      }),
      env,
    );
    assert.equal(response.status, 400);
  }
});

test("submission token only grants access to its own pending record", async () => {
  const env = createEnvironment();
  const createResponse = await handleSubmissionCreate(
    new Request("https://example.com/api/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Demo", url: "https://example.com/demo.png" }),
    }),
    env,
  );
  const created = await createResponse.json();
  const id = created.submission.id;

  const allowed = await handleSubmissionItem(
    new Request(`https://example.com/api/submissions/${id}`, { headers: { "X-Submission-Token": created.accessToken } }),
    env,
    id,
  );
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).submission.name, "Demo");

  const denied = await handleSubmissionItem(
    new Request(`https://example.com/api/submissions/${id}`, { headers: { "X-Submission-Token": "wrong-token" } }),
    env,
    id,
  );
  assert.equal(denied.status, 403);
});

test("admin list pre-checks pending submissions against the published document", async () => {
  const env = createEnvironment({ icons: [{ name: "OkEmby", url: "https://example.com/existing.png" }] });
  const id = await createSubmission(env, "okemby", "https://example.com/new.png");

  const response = await handleAdminSubmissionList(
    new Request("https://example.com/api/admin/submissions?status=pending", { headers: adminHeaders() }),
    env,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.submissions.length, 1);
  const item = body.submissions[0];
  assert.equal(item.id, id);
  assert.equal(item.conflict.name, "OkEmby");
  assert.equal(item.conflict.index, 0);
  assert.deepEqual(item.suggestions, ["okemby02", "okemby03"]);
});

test("approving a conflicting name returns a structured ICON_NAME_CONFLICT", async () => {
  const env = createEnvironment({ icons: [{ name: "OkEmby", url: "https://example.com/existing.png" }] });
  const id = await createSubmission(env, "OkEmby", "https://example.com/new.png");

  const response = await decide(env, id, { action: "approve" });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "ICON_NAME_CONFLICT");
  assert.equal(body.conflict.name, "OkEmby");
  assert.deepEqual(body.suggestions, ["OkEmby02", "OkEmby03"]);
  assert.equal(env.DB.submissions.get(id).status, "pending");
  assert.equal(readKv(env).icons.length, 1);
});

test("approve-rename publishes the submission under the new name", async () => {
  const env = createEnvironment({ icons: [{ name: "OkEmby", url: "https://example.com/existing.png" }] });
  const id = await createSubmission(env, "OkEmby", "https://example.com/new.png");

  const response = await decide(env, id, { action: "approve-rename", name: "OkEmby02" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "approved");
  assert.equal(env.DB.submissions.get(id).status, "approved");
  assert.equal(env.DB.submissions.get(id).name, "OkEmby02");
  const icons = readKv(env).icons;
  assert.equal(icons.length, 2);
  assert.deepEqual(icons[1], { name: "OkEmby02", url: "https://example.com/new.png" });
});

test("replace overwrites the existing conflicting icon", async () => {
  const env = createEnvironment({ icons: [{ name: "OkEmby", url: "https://example.com/existing.png" }] });
  const id = await createSubmission(env, "OkEmby", "https://example.com/new.png");

  const response = await decide(env, id, { action: "replace" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.replaced, true);
  const icons = readKv(env).icons;
  assert.equal(icons.length, 1);
  assert.deepEqual(icons[0], { name: "OkEmby", url: "https://example.com/new.png" });
  assert.equal(env.DB.submissions.get(id).status, "approved");
  assert.ok(env.DB.auditLogs.some((log) => log.action === "submission-approved" && log.detailsJson.includes("replaced")));
});

test("replace removes any duplicate entries sharing the normalized name", async () => {
  const env = createEnvironment({
    icons: [
      { name: "OkEmby", url: "https://example.com/one.png" },
      { name: "okemby", url: "https://example.com/two.png" },
    ],
  });
  const id = await createSubmission(env, "OkEmby", "https://example.com/new.png");

  const response = await decide(env, id, { action: "replace" });
  assert.equal(response.status, 200);
  const icons = readKv(env).icons;
  assert.equal(icons.length, 1);
  assert.deepEqual(icons[0], { name: "OkEmby", url: "https://example.com/new.png" });
});

test("reject marks the submission as rejected", async () => {
  const env = createEnvironment();
  const id = await createSubmission(env, "Demo", "https://example.com/demo.png");

  const response = await decide(env, id, { action: "reject", note: "重复内容" });
  assert.equal(response.status, 200);
  assert.equal(env.DB.submissions.get(id).status, "rejected");
  assert.equal(env.DB.submissions.get(id).reviewer_note, "重复内容");
});

test("re-approving an already published submission is idempotent", async () => {
  const env = createEnvironment({ icons: [{ name: "OkEmby", url: "https://example.com/new.png" }] });
  const id = await createSubmission(env, "OkEmby", "https://example.com/new.png");

  const response = await decide(env, id, { action: "approve" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.alreadyPublished, true);
  assert.equal(env.DB.submissions.get(id).status, "approved");
  assert.equal(readKv(env).icons.length, 1);
});

test("KV success with a failed D1 update never returns the submission to pending", async () => {
  const env = createEnvironment({ icons: [] });
  const id = await createSubmission(env, "OkEmby", "https://example.com/new.png");
  env.DB.approvalUpdateFailures = 2;

  const response = await decide(env, id, { action: "approve" });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).code, "PUBLISH_RECOVERY_REQUIRED");
  // KV already has the icon, so the row must stay in "approving", not fall back to "pending".
  assert.equal(env.DB.submissions.get(id).status, "approving");
  assert.equal(readKv(env).icons.length, 1);

  const retry = await decide(env, id, { action: "approve" });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).alreadyPublished, true);
  assert.equal(env.DB.submissions.get(id).status, "approved");
  assert.equal(readKv(env).icons.length, 1);
});
