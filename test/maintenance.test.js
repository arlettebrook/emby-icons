import assert from "node:assert/strict";
import test from "node:test";

import { DAY_MS, MAINTENANCE_STATE_KEY, runPeriodicMaintenance } from "../functions/_shared/maintenance.js";
import { createEnvironment } from "./helpers.js";

function addSubmission(env, id, status, createdAt, reviewedAt = null) {
  env.DB.submissions.set(id, {
    id,
    name: id,
    url: `https://example.com/${id}.png`,
    note: "",
    status,
    submitter_token_hash: "hash",
    ip_hash: "ip",
    created_at: createdAt,
    reviewed_at: reviewedAt,
    reviewer_id: "admin",
    reviewer_note: "",
    telegram_user_id: null,
    telegram_username: null,
    result_notified_at: null,
    source: "direct",
    normalized_name: id.toLowerCase(),
  });
}

test("periodic maintenance enforces retention windows without deleting active work", async () => {
  const env = createEnvironment();
  const now = Date.UTC(2026, 9, 20, 12, 0, 0);

  addSubmission(env, "old-approved", "approved", now - 240 * DAY_MS, now - 181 * DAY_MS);
  addSubmission(env, "recently-approved", "approved", now - 240 * DAY_MS, now - 10 * DAY_MS);
  addSubmission(env, "old-rejected", "rejected", now - 240 * DAY_MS, now - 200 * DAY_MS);
  addSubmission(env, "old-withdrawn", "withdrawn", now - 200 * DAY_MS, now - 190 * DAY_MS);
  addSubmission(env, "old-pending", "pending", now - 400 * DAY_MS);
  addSubmission(env, "old-approving", "approving", now - 400 * DAY_MS);

  env.DB.auditLogs.push(
    { actorId: "admin", action: "old", targetId: null, detailsJson: "{}", createdAt: now - 181 * DAY_MS },
    { actorId: "admin", action: "new", targetId: null, detailsJson: "{}", createdAt: now - 10 * DAY_MS },
  );
  for (let id = 1; id <= 105; id += 1) {
    env.DB.versions.push({
      id,
      document_json: JSON.stringify({ name: "Emby Icons", description: "", icons: [] }),
      etag: `"v${id}"`,
      actor_id: "admin",
      reason: "test",
      created_at: now - 100 * DAY_MS + id,
    });
  }
  env.DB.submissionAttempts.push(
    { ip_hash: "old", created_at: now - 31 * DAY_MS },
    { ip_hash: "new", created_at: now - 1 * DAY_MS },
  );
  env.DB.nameCheckAttempts.push(
    { ip_hash: "old", created_at: now - 3 * DAY_MS },
    { ip_hash: "new", created_at: now - 1 * DAY_MS },
  );

  const result = await runPeriodicMaintenance(env, { now });
  assert.equal(result.skipped, false);
  assert.equal(result.changes.submissions, 3);
  assert.equal(result.changes["audit-logs"], 1);
  assert.equal(result.changes["document-versions"], 5);
  assert.equal(result.changes["submission-attempts"], 1);
  assert.equal(result.changes["name-check-attempts"], 1);

  assert.deepEqual([...env.DB.submissions.keys()].sort(), [
    "old-approving",
    "old-pending",
    "recently-approved",
  ]);
  assert.equal(env.DB.auditLogs.length, 1);
  assert.equal(env.DB.versions.length, 100);
  assert.ok(env.DB.versions.every((version) => version.id > 5));
  assert.deepEqual(env.DB.submissionAttempts.map((row) => row.ip_hash), ["new"]);
  assert.deepEqual(env.DB.nameCheckAttempts.map((row) => row.ip_hash), ["new"]);
  assert.equal(env.EMBY_ICONS ? await env.__kv.get(MAINTENANCE_STATE_KEY) : null, String(now));
});

test("periodic maintenance runs at most once per day unless forced", async () => {
  const env = createEnvironment();
  const now = Date.UTC(2026, 9, 20, 12, 0, 0);
  assert.equal((await runPeriodicMaintenance(env, { now })).skipped, false);

  const second = await runPeriodicMaintenance(env, { now: now + 6 * 60 * 60 * 1000 });
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "recently-run");

  assert.equal((await runPeriodicMaintenance(env, { now: now + DAY_MS, force: true })).skipped, false);
});