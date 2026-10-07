import { handleAdminSubmissionDecision, handleSubmissionCreate } from "../functions/_shared/submissions.js";


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

export { FakeD1, createEnvironment, readKv, adminHeaders, createSubmission, decide };
