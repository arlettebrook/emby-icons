import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test, { beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import { ensureDatabaseSchema, resetDatabaseMigrationCacheForTests, splitSqlStatements } from "../functions/_shared/database.js";
import { MIGRATIONS } from "../functions/_shared/migrations.generated.js";
import { onRequest } from "../functions/_middleware.js";

beforeEach(() => {
  resetDatabaseMigrationCacheForTests();
});

function normalizeSql(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

class MigrationD1 {
  constructor({ applied = [], failOnceOn = null, failAlwaysOn = null } = {}) {
    this.applied = new Map(applied.map((id) => [id, Date.now()]));
    this.failOnceOn = failOnceOn;
    this.failAlwaysOn = failAlwaysOn;
    this.executed = [];
    this.batches = [];
    this.tableExists = false;
  }

  prepare(sql) {
    const db = this;
    const makeStatement = (values) => {
      const text = normalizeSql(sql);
      return {
        bind: (...nextValues) => makeStatement(nextValues),
        first: async () => db.first(text, values),
        all: async () => db.all(text, values),
        run: async () => db.run(text, values),
      };
    };
    return makeStatement([]);
  }

  async first(text, values) {
    if (text === "SELECT id FROM schema_migrations") {
      const id = [...this.applied.keys()][0];
      return id ? { id } : null;
    }
    return null;
  }

  async all(text) {
    if (text === "SELECT id FROM schema_migrations") {
      return { results: [...this.applied.keys()].map((id) => ({ id })) };
    }
    return { results: [] };
  }

  takeFailure(text) {
    if (this.failAlwaysOn && text.includes(this.failAlwaysOn)) return "forced migration failure";
    if (this.failOnceOn && text.includes(this.failOnceOn)) {
      this.failOnceOn = null;
      return "forced one-time migration failure";
    }
    return null;
  }

  async run(text, values) {
    if (text.startsWith("CREATE TABLE IF NOT EXISTS schema_migrations")) {
      this.tableExists = true;
      return { meta: { changes: 0 } };
    }
    if (text.startsWith("INSERT INTO schema_migrations")) {
      const [id, appliedAt] = values;
      if (this.applied.has(id)) throw new Error("UNIQUE constraint failed: schema_migrations.id");
      this.applied.set(id, appliedAt);
      return { meta: { changes: 1 } };
    }
    const failure = this.takeFailure(text);
    if (failure) throw new Error(failure);
    this.executed.push(text);
    return { meta: { changes: 1 } };
  }

  async batch(statements) {
    const appliedSnapshot = new Map(this.applied);
    const executedLength = this.executed.length;
    this.batches.push(statements.length);
    try {
      for (const statement of statements) await statement.run();
    } catch (error) {
      this.applied = appliedSnapshot;
      this.executed.length = executedLength;
      throw error;
    }
  }
}

test("runtime migration applies every migration once and caches the result", async () => {
  const db = new MigrationD1();
  await ensureDatabaseSchema({ DB: db });

  assert.equal(db.tableExists, true);
  assert.deepEqual([...db.applied.keys()], MIGRATIONS.map((migration) => migration.id));
  assert.equal(db.batches.length, MIGRATIONS.length);
  assert.ok(db.executed.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS submissions")));
  assert.ok(db.executed.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS submission_attempts")));

  const batchCount = db.batches.length;
  await ensureDatabaseSchema({ DB: db });
  assert.equal(db.batches.length, batchCount);
});

test("runtime migration applies only migrations missing from the ledger", async () => {
  const db = new MigrationD1({ applied: ["0001_submissions.sql"] });
  await ensureDatabaseSchema({ DB: db });

  assert.deepEqual([...db.applied.keys()], MIGRATIONS.map((migration) => migration.id));
  assert.equal(db.batches.length, MIGRATIONS.length - 1);
  assert.ok(!db.executed.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS submissions")));
  assert.ok(db.executed.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS submission_attempts")));
  assert.ok(db.executed.some((sql) => sql.includes("ADD COLUMN telegram_user_id INTEGER")));
});

test("concurrent schema checks share a single migration run", async () => {
  const db = new MigrationD1();
  await Promise.all([ensureDatabaseSchema({ DB: db }), ensureDatabaseSchema({ DB: db })]);

  assert.equal(db.batches.length, MIGRATIONS.length);
  assert.deepEqual([...db.applied.keys()], MIGRATIONS.map((migration) => migration.id));
});

test("runtime migration skips migrations already recorded in the ledger", async () => {
  const db = new MigrationD1({ applied: MIGRATIONS.map((migration) => migration.id) });
  await ensureDatabaseSchema({ DB: db });

  assert.equal(db.tableExists, true);
  assert.equal(db.batches.length, 0);
});

test("runtime migration can retry after a failed batch", async () => {
  const db = new MigrationD1({ failOnceOn: "CREATE TABLE IF NOT EXISTS submissions" });

  await assert.rejects(ensureDatabaseSchema({ DB: db }), /0001_submissions\.sql/);
  assert.equal(db.applied.size, 0);
  assert.equal(db.tableExists, true);

  await ensureDatabaseSchema({ DB: db });
  assert.deepEqual([...db.applied.keys()], MIGRATIONS.map((migration) => migration.id));
});

test("middleware runs migrations before serving API routes", async () => {
  const db = new MigrationD1();
  let nextCalled = false;

  const response = await onRequest({
    request: new Request("https://example.com/api/submissions"),
    env: { DB: db },
    next: async () => {
      nextCalled = true;
      return new Response("ok");
    },
  });

  assert.equal(response.status, 200);
  assert.equal(nextCalled, true);
  assert.deepEqual([...db.applied.keys()], MIGRATIONS.map((migration) => migration.id));
});

test("middleware returns a generic 503 when API migration fails", async () => {
  const db = new MigrationD1({ failAlwaysOn: "CREATE TABLE IF NOT EXISTS submissions" });
  let nextCalled = false;
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const response = await onRequest({
      request: new Request("https://example.com/api/submissions"),
      env: { DB: db },
      next: async () => {
        nextCalled = true;
        return new Response("ok");
      },
    });

    assert.equal(response.status, 503);
    assert.equal(nextCalled, false);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const body = await response.json();
    assert.equal(body.error, "数据库暂时不可用，请稍后重试。");
    assert.doesNotMatch(JSON.stringify(body), /CREATE TABLE|forced/);
  } finally {
    console.error = originalConsoleError;
  }
});

test("middleware keeps static pages available when migration fails", async () => {
  const db = new MigrationD1({ failAlwaysOn: "CREATE TABLE IF NOT EXISTS submissions" });
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const response = await onRequest({
      request: new Request("https://example.com/submit.html"),
      env: { DB: db },
      next: async () => new Response("page", { status: 200 }),
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "page");
  } finally {
    console.error = originalConsoleError;
  }
});

test("SQL splitter respects quoted semicolons and legal comments", () => {
  assert.deepEqual(
    splitSqlStatements(`
-- leading comment
CREATE TABLE "a;b" (value TEXT DEFAULT 'x;y');
/* block ; comment */
INSERT INTO a VALUES ('it''s; ok'); -- trailing comment
`),
    [
      'CREATE TABLE "a;b" (value TEXT DEFAULT \'x;y\')',
      "INSERT INTO a VALUES ('it''s; ok')",
    ],
  );
});

test("generated migration module matches the migrations directory", async () => {
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  assert.deepEqual(MIGRATIONS.map((migration) => migration.id), files);

  for (const [index, id] of files.entries()) {
    const sql = (await readFile(join(migrationsDir, id), "utf8")).replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
    assert.equal(MIGRATIONS[index].sql, sql);
  }
});
