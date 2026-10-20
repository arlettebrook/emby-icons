import { MIGRATIONS } from "./migrations.generated.js";

// 每个 Worker isolate 只成功检查一次；env 对象可能按请求重建，因此不按 env.DB 缓存。
let schemaReady = false;
let pendingMigration = null;

const MIGRATION_TABLE_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
)`;

function splitSqlStatements(sql) {
  const statements = [];
  let current = "";
  let quote = "";
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];

    if (lineComment) {
      if (character === "\n") {
        current += "\n";
        lineComment = false;
      }
      continue;
    }

    if (blockComment) {
      if (character === "*" && next === "/") {
        current += " ";
        index += 1;
        blockComment = false;
      }
      continue;
    }

    if (quote) {
      current += character;
      if (character === quote) {
        if (next === quote) {
          current += next;
          index += 1;
        } else {
          quote = "";
        }
      }
      continue;
    }

    if (character === "-" && next === "-") {
      index += 1;
      lineComment = true;
      continue;
    }

    if (character === "/" && next === "*") {
      index += 1;
      blockComment = true;
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      current += character;
      quote = character;
      continue;
    }

    if (character === ";") {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
      continue;
    }

    current += character;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

async function readAppliedMigrationIds(db) {
  const result = await db.prepare("SELECT id FROM schema_migrations").all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  return new Set(rows.map((row) => String(row.id)));
}

async function applyMigration(db, migration, appliedIds) {
  if (appliedIds.has(migration.id)) return;

  const statements = splitSqlStatements(migration.sql);
  const batch = [
    // 先抢占迁移记录；若其他 isolate 已抢先完成，后续语句会在同一事务中回滚。
    db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?1, ?2)").bind(migration.id, Date.now()),
    ...statements.map((statement) => db.prepare(statement)),
  ];

  try {
    await db.batch(batch);
  } catch (error) {
    // 多个 isolate 同时冷启动时允许输的一方直接复用赢家的迁移结果。
    const latestAppliedIds = await readAppliedMigrationIds(db).catch(() => null);
    if (latestAppliedIds?.has(migration.id)) return;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`数据库迁移 ${migration.id} 执行失败：${detail}`);
  }
}

async function runMigrations(db) {
  await db.prepare(MIGRATION_TABLE_SQL).run();
  const appliedIds = await readAppliedMigrationIds(db);
  const pending = MIGRATIONS.filter((migration) => !appliedIds.has(migration.id));
  for (const migration of pending) {
    await applyMigration(db, migration, appliedIds);
    appliedIds.add(migration.id);
  }
}

export function ensureDatabaseSchema(env) {
  const db = env?.DB;
  if (!db) return Promise.resolve();
  if (schemaReady) return Promise.resolve();
  if (pendingMigration) return pendingMigration;

  pendingMigration = runMigrations(db)
    .then(() => {
      schemaReady = true;
    })
    .finally(() => {
      pendingMigration = null;
    });
  return pendingMigration;
}

export function resetDatabaseMigrationCacheForTests() {
  schemaReady = false;
  pendingMigration = null;
}

export { splitSqlStatements };
