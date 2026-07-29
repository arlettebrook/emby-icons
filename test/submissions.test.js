import assert from "node:assert/strict";
import test from "node:test";

import {
  handleSubmissionCreate,
  handleSubmissionItem,
} from "../functions/_shared/submissions.js";

class FakeD1 {
  constructor() {
    this.submissions = new Map();
  }

  prepare(sql) {
    return {
      bind: (...values) => ({
        first: async () => {
          if (sql.includes("SELECT COUNT(*)")) {
            const [ipHash, cutoff] = values;
            return {
              count: [...this.submissions.values()].filter((row) => row.ip_hash === ipHash && row.created_at >= cutoff && row.status !== "withdrawn").length,
            };
          }
          if (sql.includes("FROM submissions WHERE id")) return this.submissions.get(values[0]) || null;
          return null;
        },
        run: async () => {
          if (sql.includes("INSERT INTO submissions")) {
            const [id, name, url, note, tokenHash, ipHash, createdAt] = values;
            this.submissions.set(id, {
              id,
              name,
              url,
              note,
              status: "pending",
              submitter_token_hash: tokenHash,
              ip_hash: ipHash,
              created_at: createdAt,
            });
          }
          return { meta: { changes: 1 } };
        },
      }),
    };
  }
}

function createEnvironment() {
  return { DB: new FakeD1(), ADMIN_TOKEN: "admin-secret", SUBMISSION_HASH_SECRET: "test-secret" };
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
