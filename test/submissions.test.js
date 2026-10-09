import assert from "node:assert/strict";
import test from "node:test";

import {
  handleAdminSubmissionList,
  handleSubmissionCreate,
  handleSubmissionItem,
} from "../functions/_shared/submissions.js";
import { adminHeaders, createEnvironment, createSubmission, decide, readKv } from "./helpers.js";
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
  assert.deepEqual(item.suggestions, ["okemby01", "okemby02"]);
});

test("approving a conflicting name returns a structured ICON_NAME_CONFLICT", async () => {
  const env = createEnvironment({ icons: [{ name: "OkEmby", url: "https://example.com/existing.png" }] });
  const id = await createSubmission(env, "OkEmby", "https://example.com/new.png");

  const response = await decide(env, id, { action: "approve" });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "ICON_NAME_CONFLICT");
  assert.equal(body.conflict.name, "OkEmby");
  assert.deepEqual(body.suggestions, ["OkEmby01", "OkEmby02"]);
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