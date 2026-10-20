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

// 创建一条提交并返回它的访问凭证，供撤回/重新提交/删除用例使用；
// 开启 Turnstile 校验的用例需要传入一次性验证令牌。
async function createWithToken(env, name, url, turnstileToken) {
  const response = await handleSubmissionCreate(
    new Request("https://example.com/api/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(turnstileToken ? { "X-Turnstile-Token": turnstileToken } : {}) },
      body: JSON.stringify({ name, url }),
    }),
    env,
  );
  const status = response.status;
  const body = await response.json();
  return {
    response,
    status,
    body,
    id: body.submission?.id,
    token: body.accessToken,
  };
}

function ownerRequest(id, token, init = {}) {
  return new Request(`https://example.com/api/submissions/${id}`, {
    ...init,
    headers: { "X-Submission-Token": token, ...(init.headers || {}) },
  });
}
test("daily submission quota cannot be restored by withdrawing or deleting", async () => {
  const withdrawnEnv = createEnvironment();
  withdrawnEnv.SUBMISSION_DAILY_LIMIT = "1";
  const withdrawn = await createWithToken(withdrawnEnv, "First", "https://example.com/first.png");
  await handleSubmissionItem(ownerRequest(withdrawn.id, withdrawn.token, { method: "POST" }), withdrawnEnv, withdrawn.id);
  assert.equal(withdrawnEnv.DB.submissions.get(withdrawn.id).status, "withdrawn");
  const afterWithdraw = await createWithToken(withdrawnEnv, "Second", "https://example.com/second.png");
  assert.equal(afterWithdraw.status, 429);

  const deletedEnv = createEnvironment();
  deletedEnv.SUBMISSION_DAILY_LIMIT = "1";
  const deleted = await createWithToken(deletedEnv, "First", "https://example.com/first.png");
  await handleSubmissionItem(ownerRequest(deleted.id, deleted.token, { method: "DELETE" }), deletedEnv, deleted.id);
  const afterDelete = await createWithToken(deletedEnv, "Second", "https://example.com/second.png");
  assert.equal(afterDelete.status, 429);
});

test("resubmitting a rejected submission consumes the daily quota", async () => {
  const env = createEnvironment();
  env.SUBMISSION_DAILY_LIMIT = "1";
  const { id, token } = await createWithToken(env, "Demo", "https://example.com/demo.png");
  await decide(env, id, { action: "reject", note: "重试" });
  const response = await handleSubmissionItem(
    ownerRequest(id, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Demo", url: "https://example.com/demo.png", note: "", resubmit: true }),
    }),
    env,
    id,
  );
  assert.equal(response.status, 429);
  assert.equal(env.DB.submissions.get(id).status, "rejected");
});

test("submission endpoints fail closed when the hash secret is missing", async () => {
  const env = createEnvironment();
  const { id, token } = await createWithToken(env, "Demo", "https://example.com/demo.png");

  const missing = await createWithToken(env, "Other", "https://example.com/other.png");
  delete env.SUBMISSION_HASH_SECRET;
  const blocked = await createWithToken(env, "Other", "https://example.com/other.png");
  assert.equal(blocked.status, 503);
  assert.match(blocked.body.error, /SUBMISSION_HASH_SECRET/);
  const blockedRead = await handleSubmissionItem(ownerRequest(id, token), env, id);
  assert.equal(blockedRead.status, 503);

  env.SUBMISSION_HASH_SECRET = "test-secret";
  env.ADMIN_TOKEN = "rotated-admin-token";
  const stillValid = await handleSubmissionItem(ownerRequest(id, token), env, id);
  assert.equal(stillValid.status, 200);
  assert.equal(missing.status, 201);
});

test("an audit log failure does not fail submission creation", async () => {
  const env = createEnvironment();
  env.DB.auditFailures = 1;
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await handleSubmissionCreate(
      new Request("https://example.com/api/submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Audited", url: "https://example.com/audited.png" }),
      }),
      env,
    );
    assert.equal(response.status, 201);
    assert.equal(env.DB.submissions.size, 1);
    assert.equal(env.DB.auditLogs.length, 0);
  } finally {
    console.error = originalError;
  }
});

test("production Turnstile configuration fails closed without a secret", async () => {
  for (const [name, value] of [["ENVIRONMENT", "production"], ["CF_PAGES_BRANCH", "master"]]) {
    const env = createEnvironment();
    env[name] = value;
    const response = await handleSubmissionCreate(
      new Request("https://example.com/api/submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Blocked", url: "https://example.com/blocked.png" }),
      }),
      env,
    );
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /Turnstile is not configured/);
    assert.equal(env.DB.submissions.size, 0);
  }
});

test("a rejected submission can be edited and resubmitted into the queue", async () => {
  const env = createEnvironment();
  const { id, token } = await createWithToken(env, "Demo", "https://example.com/demo.png");
  await decide(env, id, { action: "reject", note: "名字太随意" });
  assert.equal(env.DB.submissions.get(id).status, "rejected");

  const response = await handleSubmissionItem(
    ownerRequest(id, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "DemoFixed",
        url: "https://example.com/demo-fixed.png",
        note: "按拒绝原因改好了",
        resubmit: true,
      }),
    }),
    env,
    id,
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.resubmitted, true);
  assert.equal(body.submission.status, "pending");
  assert.equal(body.submission.name, "DemoFixed");
  const row = env.DB.submissions.get(id);
  assert.equal(row.status, "pending");
  assert.equal(row.name, "DemoFixed");
  assert.equal(row.url, "https://example.com/demo-fixed.png");
  // 重新排队必须清掉旧的拒绝结论，否则审核人会看到过期的原因。
  assert.equal(row.reviewer_note, null);
  assert.equal(row.reviewer_id, null);
  assert.equal(row.reviewed_at, null);
  const audit = env.DB.auditLogs.map((entry) => entry.action);
  assert.ok(audit.includes("submission-resubmitted"));
});

test("a withdrawn submission can be resubmitted without resubmit-flag errors", async () => {
  const env = createEnvironment();
  const { id, token } = await createWithToken(env, "Demo", "https://example.com/demo.png");
  await handleSubmissionItem(ownerRequest(id, token, { method: "POST" }), env, id);
  assert.equal(env.DB.submissions.get(id).status, "withdrawn");

  const response = await handleSubmissionItem(
    ownerRequest(id, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Demo", url: "https://example.com/demo.png", note: "", resubmit: true }),
    }),
    env,
    id,
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).submission.status, "pending");
  assert.equal(env.DB.submissions.get(id).status, "pending");
});

test("Turnstile is required for editing pending records and resubmitting rejected ones", async () => {
  const env = createEnvironment({ turnstileSecret: "turnstile-secret", requireTurnstile: true });
  const originalFetch = globalThis.fetch;
  const verified = [];
  globalThis.fetch = async (url, init) => {
    verified.push({ url: String(url), body: String(init?.body || "") });
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const { id, token } = await createWithToken(env, "Demo", "https://example.com/demo.png", "create-token");
    await decide(env, id, { action: "reject", note: "名字太随意" });
    assert.equal(env.DB.submissions.get(id).status, "rejected");

    const resubmit = (headers) =>
      handleSubmissionItem(
        ownerRequest(id, token, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ name: "Demo", url: "https://example.com/demo.png", note: "", resubmit: true }),
        }),
        env,
        id,
      );

    // 没有令牌：拒绝，并且不能改动记录。
    const denied = await resubmit({});
    assert.equal(denied.status, 403);
    assert.match((await denied.json()).error, /turnstile/i);
    assert.equal(env.DB.submissions.get(id).status, "rejected");

    // 带令牌：放行，并且确实调用了 Cloudflare 的 siteverify。
    const allowed = await resubmit({ "X-Turnstile-Token": "site-token" });
    assert.equal(allowed.status, 200);
    assert.equal(env.DB.submissions.get(id).status, "pending");
    assert.ok(verified.some((call) => call.url.includes("siteverify") && call.body.includes("response=site-token")));

    // 待审核的「编辑提交」同样要过这道验证：没有令牌一律拒绝，而且不能改动记录。
    const { id: pendingId, token: pendingToken } = await createWithToken(env, "Other", "https://example.com/other.png", "create-token");
    const edit = (headers) =>
      handleSubmissionItem(
        ownerRequest(pendingId, pendingToken, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ name: "OtherFixed", url: "https://example.com/other.png", note: "" }),
        }),
        env,
        pendingId,
      );

    const blockedEdit = await edit({});
    assert.equal(blockedEdit.status, 403);
    assert.match((await blockedEdit.json()).error, /turnstile/i);
    assert.equal(env.DB.submissions.get(pendingId).name, "Other");

    const allowedEdit = await edit({ "X-Turnstile-Token": "edit-token" });
    assert.equal(allowedEdit.status, 200);
    assert.equal(env.DB.submissions.get(pendingId).name, "OtherFixed");
    assert.ok(verified.some((call) => call.url.includes("siteverify") && call.body.includes("response=edit-token")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("editing a pending submission still works when Turnstile is not configured", async () => {
  const env = createEnvironment();
  const { id, token } = await createWithToken(env, "Demo", "https://example.com/demo.png");

  const response = await handleSubmissionItem(
    ownerRequest(id, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "DemoFixed", url: "https://example.com/demo-fixed.png", note: "改好了" }),
    }),
    env,
    id,
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).submission.name, "DemoFixed");
  assert.equal(env.DB.submissions.get(id).name, "DemoFixed");
});

test("editing a resolved submission without the resubmit flag stays rejected", async () => {
  const env = createEnvironment();
  const { id, token } = await createWithToken(env, "Demo", "https://example.com/demo.png");
  await decide(env, id, { action: "reject", note: "" });

  const response = await handleSubmissionItem(
    ownerRequest(id, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Nope", url: "https://example.com/nope.png", note: "" }),
    }),
    env,
    id,
  );

  assert.equal(response.status, 409);
  assert.equal(env.DB.submissions.get(id).status, "rejected");
  assert.equal(env.DB.submissions.get(id).name, "Demo");
});

test("deleting a submission removes the record for its owner", async () => {
  const env = createEnvironment();
  const { id, token } = await createWithToken(env, "Demo", "https://example.com/demo.png");

  const response = await handleSubmissionItem(ownerRequest(id, token, { method: "DELETE" }), env, id);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deleted, true);
  assert.equal(env.DB.submissions.has(id), false);
  assert.ok(env.DB.auditLogs.some((entry) => entry.action === "submission-deleted"));

  // 记录已经不存在，后续读取必须变成 404 而不是悄悄返回旧数据。
  const after = await handleSubmissionItem(ownerRequest(id, token), env, id);
  assert.equal(after.status, 404);
});

test("deleting requires the owner token and skips mid-publication records", async () => {
  const env = createEnvironment();
  const { id, token } = await createWithToken(env, "Demo", "https://example.com/demo.png");

  const denied = await handleSubmissionItem(
    ownerRequest(id, "wrong-token", { method: "DELETE" }),
    env,
    id,
  );
  assert.equal(denied.status, 403);
  assert.equal(env.DB.submissions.has(id), true);

  env.DB.submissions.get(id).status = "approving";
  const blocked = await handleSubmissionItem(ownerRequest(id, token, { method: "DELETE" }), env, id);
  assert.equal(blocked.status, 409);
  assert.equal(env.DB.submissions.has(id), true);
});
