import assert from "node:assert/strict";
import test from "node:test";

import { cleanupDatabase, getCleanupConfig } from "../functions/_shared/cleanup.js";

class FakeD1 {
  constructor({ submissions = [], auditLogs = [], documentVersions = [] } = {}) {
    this.tables = {
      submissions: structuredClone(submissions),
      audit_logs: structuredClone(auditLogs),
      document_versions: structuredClone(documentVersions),
    };
  }

  prepare(sql) {
    const table = Object.keys(this.tables).find((name) => sql.includes(`FROM ${name}`) || sql.includes(`INTO ${name}`));
    return {
      bind: (...values) => ({
        first: async () => {
          const rows = this.eligible(table, sql, values);
          return { count: rows.length };
        },
        run: async () => {
          const batchSize = values.at(-1);
          const rows = this.eligible(table, sql, values).slice(0, batchSize);
          const ids = new Set(rows.map((row) => row.id));
          this.tables[table] = this.tables[table].filter((row) => !ids.has(row.id));
          return { meta: { changes: rows.length } };
        },
      }),
    };
  }

  eligible(table, sql, values) {
    const cutoff = values[0];
    let rows = this.tables[table].filter((row) => row.created_at < cutoff);
    if (table === "submissions") rows = rows.filter((row) => ["approved", "rejected", "withdrawn"].includes(row.status));
    if (table === "document_versions") {
      const keep = values[1];
      const newest = [...this.tables[table]]
        .sort((left, right) => right.created_at - left.created_at || right.id - left.id)
        .slice(0, keep)
        .map((row) => row.id);
      rows = rows.filter((row) => !newest.includes(row.id));
    }
    return rows.sort((left, right) => left.created_at - right.created_at || String(left.id).localeCompare(String(right.id)));
  }
}

const now = 1_000_000_000_000;
const old = now - 2 * 24 * 60 * 60 * 1000;

test("cleanup keeps pending submissions and the newest document snapshot", async () => {
  const env = {
    CLEANUP_SUBMISSIONS_DAYS: "1",
    CLEANUP_AUDIT_LOGS_DAYS: "1",
    CLEANUP_DOCUMENT_VERSIONS_DAYS: "1",
    CLEANUP_DOCUMENT_VERSIONS_KEEP: "1",
    CLEANUP_BATCH_SIZE: "1",
    CLEANUP_MAX_BATCHES: "10",
    DB: new FakeD1({
      submissions: [
        { id: "approved-old", status: "approved", created_at: old },
        { id: "pending-old", status: "pending", created_at: old },
      ],
      auditLogs: [
        { id: 1, created_at: old },
        { id: 2, created_at: now },
      ],
      documentVersions: [
        { id: 1, created_at: old - 2_000 },
        { id: 2, created_at: old - 1_000 },
        { id: 3, created_at: old },
      ],
    }),
  };

  const result = await cleanupDatabase(env, { now });

  assert.deepEqual(result.deleted, { submissions: 1, auditLogs: 1, documentVersions: 2 });
  assert.deepEqual(env.DB.tables.submissions.map((row) => row.id), ["pending-old"]);
  assert.deepEqual(env.DB.tables.audit_logs.map((row) => row.id), [2]);
  assert.deepEqual(env.DB.tables.document_versions.map((row) => row.id), [3]);
});

test("cleanup dry run reports rows without deleting them", async () => {
  const env = {
    CLEANUP_SUBMISSIONS_DAYS: "1",
    CLEANUP_AUDIT_LOGS_DAYS: "1",
    CLEANUP_DOCUMENT_VERSIONS_DAYS: "1",
    DB: new FakeD1({ submissions: [{ id: "old", status: "rejected", created_at: old }] }),
  };
  const result = await cleanupDatabase(env, { now, dryRun: true });

  assert.equal(result.dryRun, true);
  assert.equal(result.eligible.submissions, 1);
  assert.equal(env.DB.tables.submissions.length, 1);
});

test("cleanup configuration uses safe defaults", () => {
  assert.deepEqual(getCleanupConfig({}), {
    submissionsDays: 180,
    auditLogsDays: 365,
    documentVersionsDays: 365,
    documentVersionsKeep: 20,
    batchSize: 100,
    maxBatches: 10,
  });
});
