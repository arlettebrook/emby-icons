import { createHmac } from "node:crypto";

import { handleAdminSubmissionDecision, handleSubmissionCreate } from "../functions/_shared/submissions.js";


class FakeD1 {
  constructor() {
    this.submissions = new Map();
    this.submissionAttempts = [];
    this.locks = new Map();
    this.auditLogs = [];
    this.versions = [];
    this.approvalUpdateFailures = 0;
    this.auditFailures = 0;
    this.resultNotificationClaimFailures = 0;
    this.resultNotificationReleaseFailures = 0;
  }

  prepare(sql) {
    const text = sql.replace(/\s+/g, " ").trim();
    const db = this;
    const statement = (values) => ({
        first: async () => {
          if (text.startsWith("SELECT COUNT(*)") && text.includes("submission_attempts")) {
            const [ipHash, cutoff] = values;
            return {
              count: db.submissionAttempts.filter((row) => row.ip_hash === ipHash && row.created_at >= cutoff).length,
            };
          }
          if (text.startsWith("SELECT COUNT(*)")) {
            const [ipHash, cutoff] = values;
            return {
              count: [...db.submissions.values()].filter(
                (row) => row.ip_hash === ipHash && row.created_at >= cutoff && row.status !== "withdrawn",
              ).length,
            };
          }
          if (text.startsWith("SELECT id, name, status, reviewer_note, telegram_user_id, result_notified_at")) {
            return db.submissions.get(values[0]) || null;
          }
          if (text.startsWith("SELECT id, name, url, note, status")) {
            return db.submissions.get(values[0]) || null;
          }
          if (text.startsWith("SELECT name FROM submissions WHERE id =")) {
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
            const telegramOwned = text.includes("WHERE telegram_user_id = ?1");
            const scoped = text.includes("WHERE status = ?1");
            const pendingOnly = text.includes("WHERE status = 'pending'");
            const telegramUserId = telegramOwned ? values[0] : null;
            const status = scoped ? values[0] : pendingOnly ? "pending" : null;
            const limit = telegramOwned ? values[1] : scoped ? values[1] : values[0];
            const rows = [...db.submissions.values()]
              .filter((row) => (
                (telegramOwned ? String(row.telegram_user_id) === String(telegramUserId) : true) &&
                (status ? row.status === status : true)
              ))
              .sort((a, b) => b.created_at - a.created_at)
              .slice(0, limit);
            return { results: rows };
          }
          return { results: [] };
        },
        run: async () => {
          if (text.startsWith("INSERT INTO submission_attempts")) {
            const [ipHash, createdAt, cutoff, limit] = values;
            const count = db.submissionAttempts.filter(
              (row) => row.ip_hash === ipHash && row.created_at >= cutoff,
            ).length;
            if (count >= Number(limit)) return { meta: { changes: 0 } };
            db.submissionAttempts.push({ ip_hash: ipHash, created_at: createdAt });
            return { meta: { changes: 1 } };
          }
          if (text.startsWith("INSERT INTO submissions")) {
            const [id, name, url, note, tokenHash, ipHash, createdAt, telegramUserId, telegramUsername] = values;
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
              telegram_user_id: telegramUserId ?? null,
              telegram_username: telegramUsername ?? null,
              result_notified_at: null,
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
          if (text.startsWith("DELETE FROM submissions WHERE id = ?1")) {
            const existed = db.submissions.delete(values[0]);
            return { meta: { changes: existed ? 1 : 0 } };
          }
          if (text.startsWith("UPDATE submissions SET name = ?1, url = ?2, note = ?3, status = 'pending'")) {
            // 重新提交：被拒绝/已撤回的记录改好后回到待审核队列。
            const [name, url, note, id] = values;
            const row = db.submissions.get(id);
            if (row && (row.status === "rejected" || row.status === "withdrawn")) {
              row.name = name;
              row.url = url;
              row.note = note;
              row.status = "pending";
              row.reviewer_id = null;
              row.reviewer_note = null;
              row.reviewed_at = null;
              row.result_notified_at = null;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (text.startsWith("UPDATE submissions SET name = ?1, url = ?2, note = ?3 WHERE id = ?4 AND status = 'pending'")) {
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
            const [name, url, note, reviewerId, reviewedAt, id] = values;
            const row = db.submissions.get(id);
            if (row && (row.status === "approving" || row.status === "pending")) {
              row.status = "approved";
              row.name = name;
              if (url !== null && url !== undefined) row.url = url;
              if (note !== null && note !== undefined) row.note = note;
              row.reviewer_id = reviewerId;
              row.reviewed_at = reviewedAt;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (text.startsWith("UPDATE submissions SET result_notified_at = ?1")) {
            if (db.resultNotificationClaimFailures > 0) {
              db.resultNotificationClaimFailures -= 1;
              throw new Error("D1 result notification claim failed");
            }
            const [claimedAt, id] = values;
            const row = db.submissions.get(id);
            if (row?.telegram_user_id && row.result_notified_at == null) {
              row.result_notified_at = claimedAt;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (text.startsWith("UPDATE submissions SET result_notified_at = NULL WHERE id = ?1")) {
            if (db.resultNotificationReleaseFailures > 0) {
              db.resultNotificationReleaseFailures -= 1;
              throw new Error("D1 result notification release failed");
            }
            const [id, claimedAt] = values;
            const row = db.submissions.get(id);
            if (row && row.result_notified_at === claimedAt) {
              row.result_notified_at = null;
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
            if (db.auditFailures > 0) {
              db.auditFailures -= 1;
              throw new Error("D1 audit write failed");
            }
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

function createEnvironment({ icons = [], kvUnavailable = false, turnstileSecret = "", requireTurnstile = false } = {}) {
  const values = new Map();
  const document = { name: "Emby Icons", description: "Test", icons };
  values.set("emby-icons.json", `${JSON.stringify(document, null, 2)}\n`);
  const env = {
    DB: new FakeD1(),
    ADMIN_TOKEN: "admin-secret",
    SUBMISSION_HASH_SECRET: "test-secret",
    ...(turnstileSecret ? { TURNSTILE_SECRET_KEY: turnstileSecret } : {}),
    ...(requireTurnstile ? { REQUIRE_TURNSTILE: "true" } : {}),
    EMBY_ICONS: {
      get: async (key) => (kvUnavailable ? null : values.get(key) ?? null),
      put: async (key, value) => {
        values.set(key, value);
      },
      delete: async (key) => { values.delete(key); },
      list: async () => ({ keys: [...values.keys()].map((name) => ({ name })) }),
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

async function createSubmission(env, name, url, { initData = "" } = {}) {
  const response = await handleSubmissionCreate(
    new Request("https://example.com/api/submissions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(initData ? { "X-Telegram-Init-Data": initData } : {}),
      },
      body: JSON.stringify({ name, url }),
    }),
    env,
  );
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Submission creation failed (" + response.status + ")");
  return body.submission.id;
}

function makeTelegramInitData(token, user = { id: 1001, username: "test_user" }, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams();
  params.set("auth_date", String(authDate));
  params.set("query_id", "AAH-test-query");
  params.set("user", JSON.stringify(user));
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => key + "=" + value)
    .join(String.fromCharCode(10));
  const secretKey = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  params.set("hash", hash);
  return params.toString();
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

export { FakeD1, createEnvironment, readKv, adminHeaders, createSubmission, decide, makeTelegramInitData };
