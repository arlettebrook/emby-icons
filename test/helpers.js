import { createHmac } from "node:crypto";

import { handleAdminSubmissionDecision, handleSubmissionCreate } from "../functions/_shared/submissions.js";


class FakeD1 {
  constructor() {
    this.submissions = new Map();
    this.submissionAttempts = [];
    this.nameCheckAttempts = [];
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
        if (text.startsWith("SELECT COUNT(*)") && text.includes("name_check_attempts")) {
          const [ipHash, cutoff] = values;
          return {
            count: db.nameCheckAttempts.filter(
              (row) => row.ip_hash === ipHash && row.created_at >= cutoff,
            ).length,
          };
        }
        if (text.startsWith("SELECT COUNT(*)") && text.includes("submission_attempts")) {
          const [ipHash, cutoff] = values;
          return {
            count: db.submissionAttempts.filter(
              (row) => row.ip_hash === ipHash && row.created_at >= cutoff,
            ).length,
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
        if (text.includes("normalized_name = ?1") && text.includes("lower(trim(name))")) {
          const normalized = values[0];
          return [...db.submissions.values()].find((row) => (
            row.status === "pending" &&
            (row.normalized_name === normalized ||
              (row.normalized_name == null && String(row.name || "").trim().toLowerCase() === normalized))
          )) || null;
        }
        if (text.includes("FROM submissions") && text.includes("WHERE id = ?1")) {
          return db.submissions.get(values[0]) || null;
        }
        if (text.startsWith("SELECT name FROM submissions WHERE id =")) {
          return db.submissions.get(values[0]) || null;
        }
        if (text.includes("FROM document_versions") && text.includes("WHERE id = ?1")) {
          return db.versions.find((row) => Number(row.id) === Number(values[0])) || null;
        }
        if (text.startsWith("SELECT owner FROM document_publish_lock")) {
          const lock = db.locks.get("canonical");
          return lock ? { owner: lock.owner } : null;
        }
        return null;
      },
      all: async () => {
        if (text.includes("GROUP BY status, source, reviewer_id")) {
          const groups = new Map();
          for (const row of db.submissions.values()) {
            const key = [row.status || "unknown", row.source || "direct", row.reviewer_id || ""].join("\u0000");
            groups.set(key, (groups.get(key) || 0) + 1);
          }
          return {
            results: [...groups].map(([key, count]) => {
              const [status, source, reviewer_id] = key.split("\u0000");
              return { status, source, reviewer_id: reviewer_id || null, count };
            }),
          };
        }
        if (text.includes("(?1 = 'all' OR status = ?1)")) {
          const [status, q, pattern, reviewer, hasCursor, cursorCreatedAt, cursorId, pageLimit] = values;
          let rows = [...db.submissions.values()];
          if (status !== "all") rows = rows.filter((row) => row.status === status);
          const term = String(q || "").toLowerCase();
          if (term) {
            rows = rows.filter((row) => (
              String(row.name || "").toLowerCase().includes(term) ||
              String(row.url || "").toLowerCase().includes(term)
            ));
          }
          if (reviewer) rows = rows.filter((row) => String(row.reviewer_id || "") === String(reviewer));
          if (hasCursor) {
            const createdAt = Number(cursorCreatedAt);
            const id = String(cursorId || "");
            rows = rows.filter((row) => row.created_at < createdAt || (row.created_at === createdAt && String(row.id) < id));
          }
          rows.sort((a, b) => b.created_at - a.created_at || String(b.id).localeCompare(String(a.id)));
          return { results: rows.slice(0, Number(pageLimit) || 50) };
        }
        if (text.includes("FROM submissions")) {
          let rows = [...db.submissions.values()];
          let limit = 100;
          let consumed = 0;
          const has = (fragment) => text.includes(fragment);

          if (has("WHERE telegram_user_id = ?1")) {
            rows = rows.filter((row) => String(row.telegram_user_id) === String(values[consumed]));
            consumed += 1;
          } else if (has("WHERE status = ?1")) {
            rows = rows.filter((row) => row.status === values[consumed]);
            consumed += 1;
          } else if (has("WHERE status = 'pending'")) {
            rows = rows.filter((row) => row.status === "pending");
          } else if (has("status = ")) {
            const statusMatch = text.match(/status\s*=\s*'([^']+)'/);
            if (statusMatch) rows = rows.filter((row) => row.status === statusMatch[1]);
          }

          if (has("normalized_name = ?")) {
            const normalized = values[consumed];
            consumed += 1;
            rows = rows.filter((row) => (
              row.status === "pending" &&
              (row.normalized_name === normalized ||
                (row.normalized_name == null && String(row.name || "").trim().toLowerCase() === normalized))
            ));
          }
          if (has("reviewer_id = ?")) {
            const reviewerId = values[consumed];
            consumed += 1;
            rows = rows.filter((row) => String(row.reviewer_id || "") === String(reviewerId));
          }
          if (has("(name LIKE ?") || has("name LIKE ?")) {
            const term = String(values[consumed] || "").replaceAll("%", "").toLowerCase();
            consumed += 1;
            rows = rows.filter((row) => (
              String(row.name || "").toLowerCase().includes(term) ||
              String(row.url || "").toLowerCase().includes(term)
            ));
          }
          if (has("(created_at < ?") || has("created_at < ?")) {
            const createdAt = Number(values[consumed]);
            const id = String(values[consumed + 1] || "");
            consumed += 2;
            rows = rows.filter((row) => row.created_at < createdAt || (row.created_at === createdAt && String(row.id) < id));
          }

          const limitValue = values[values.length - 1];
          if (Number.isFinite(Number(limitValue))) limit = Number(limitValue);
          return {
            results: rows
              .sort((a, b) => b.created_at - a.created_at || String(b.id).localeCompare(String(a.id)))
              .slice(0, limit),
          };
        }
        if (text.includes("FROM document_versions")) {
          let rows = db.versions.slice();
          if (text.includes("(?1 = 0 OR id < ?2)")) {
            const [hasCursor, cursorId, pageLimit] = values;
            if (hasCursor) rows = rows.filter((row) => Number(row.id) < Number(cursorId));
            rows.sort((a, b) => Number(b.id) - Number(a.id));
            return { results: rows.slice(0, Number(pageLimit)) };
          }
          if (text.includes("WHERE id <= ?1")) {
            const cutoffId = Number(values[0]);
            rows = rows.filter((row) => Number(row.id) <= cutoffId);
          }
          const limitValue = values[values.length - 1];
          if (Number.isFinite(Number(limitValue))) rows = rows.slice(0, Number(limitValue));
          return { results: rows };
        }
        if (text.includes("FROM audit_logs")) {
          const limitValue = values[values.length - 1];
          const rows = db.auditLogs
            .slice()
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, Number.isFinite(Number(limitValue)) ? Number(limitValue) : 100);
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
        if (text.startsWith("INSERT INTO name_check_attempts")) {
          const [ipHash, createdAt, cutoff, limit] = values;
          const count = db.nameCheckAttempts.filter(
            (row) => row.ip_hash === ipHash && row.created_at >= cutoff,
          ).length;
          if (count >= Number(limit)) return { meta: { changes: 0 } };
          db.nameCheckAttempts.push({ ip_hash: ipHash, created_at: createdAt });
          return { meta: { changes: 1 } };
        }
        if (text.startsWith("INSERT INTO submissions")) {
          const [id, name, url, note, tokenHash, ipHash, createdAt, telegramUserId, telegramUsername, source, normalizedName] = values;
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
            source: source || "direct",
            normalized_name: normalizedName || String(name).trim().toLowerCase(),
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
        if (text.startsWith("DELETE FROM submissions") && text.includes("COALESCE(reviewed_at, created_at) <")) {
          const [cutoff] = values;
          let changes = 0;
          for (const [id, row] of db.submissions) {
            const processed = ["approved", "rejected", "withdrawn"].includes(row.status);
            const processedAt = Number(row.reviewed_at || row.created_at);
            if (processed && processedAt < cutoff) {
              db.submissions.delete(id);
              changes += 1;
            }
          }
          return { meta: { changes } };
        }
        if (text.startsWith("UPDATE submissions SET name = ?1, normalized_name = ?2, url = ?3, note = ?4 WHERE id = ?5 AND status = 'pending'")) {
          const [name, normalizedName, url, note, id] = values;
          const row = db.submissions.get(id);
          if (row && row.status === "pending") {
            row.name = name;
            row.normalized_name = normalizedName;
            row.url = url;
            row.note = note;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        if (text.startsWith("UPDATE submissions SET name = ?1, normalized_name = ?2, url = ?3, note = ?4, status = 'pending'")) {
          const [name, normalizedName, url, note, id] = values;
          const row = db.submissions.get(id);
          if (row && (row.status === "rejected" || row.status === "withdrawn")) {
            row.name = name;
            row.normalized_name = normalizedName;
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
          const [name, normalizedName, url, note, reviewerId, reviewedAt, id] = values;
          const row = db.submissions.get(id);
          if (row && (row.status === "approving" || row.status === "pending")) {
            row.status = "approved";
            row.name = name;
            row.normalized_name = normalizedName;
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
        if (text.startsWith("DELETE FROM audit_logs")) {
          const [cutoff] = values;
          const before = db.auditLogs.length;
          db.auditLogs = db.auditLogs.filter((row) => row.createdAt >= cutoff);
          return { meta: { changes: before - db.auditLogs.length } };
        }
        if (text.startsWith("INSERT INTO document_versions")) {
          const [documentJson, etag, actorId, reason, createdAt] = values;
          const row = {
            id: db.versions.length + 1,
            document_json: documentJson,
            etag,
            actor_id: actorId,
            reason,
            created_at: createdAt,
          };
          db.versions.push(row);
          return { meta: { changes: 1 } };
        }
        if (text.startsWith("DELETE FROM document_versions")) {
          const [cutoff, keep] = values;
          const sorted = db.versions.slice().sort((a, b) => b.created_at - a.created_at);
          const keepIds = new Set(sorted.slice(0, Number(keep) || 0).map((row) => row.id));
          const before = db.versions.length;
          db.versions = db.versions.filter((row) => row.created_at >= cutoff || keepIds.has(row.id));
          return { meta: { changes: before - db.versions.length } };
        }
        if (text.startsWith("DELETE FROM submission_attempts")) {
          const [cutoff] = values;
          const before = db.submissionAttempts.length;
          db.submissionAttempts = db.submissionAttempts.filter((row) => row.created_at >= cutoff);
          return { meta: { changes: before - db.submissionAttempts.length } };
        }
        if (text.startsWith("DELETE FROM name_check_attempts")) {
          const [cutoff] = values;
          const before = db.nameCheckAttempts.length;
          db.nameCheckAttempts = db.nameCheckAttempts.filter((row) => row.created_at >= cutoff);
          return { meta: { changes: before - db.nameCheckAttempts.length } };
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
