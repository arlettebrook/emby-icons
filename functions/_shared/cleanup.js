import { hasAdminAccess } from "./admin.js";
import { writeAuditLog } from "./icons.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SUBMISSIONS_RETENTION_DAYS = 180;
const DEFAULT_AUDIT_LOGS_RETENTION_DAYS = 365;
const DEFAULT_DOCUMENT_VERSIONS_RETENTION_DAYS = 365;
const DEFAULT_DOCUMENT_VERSIONS_KEEP = 20;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_BATCHES = 10;

function positiveInteger(value, fallback, maximum = 10_000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), 0), maximum);
}

function retentionDays(value, fallback) {
  return positiveInteger(value, fallback, 3_650);
}

export function getCleanupConfig(env) {
  return {
    submissionsDays: retentionDays(env.CLEANUP_SUBMISSIONS_DAYS, DEFAULT_SUBMISSIONS_RETENTION_DAYS),
    auditLogsDays: retentionDays(env.CLEANUP_AUDIT_LOGS_DAYS, DEFAULT_AUDIT_LOGS_RETENTION_DAYS),
    documentVersionsDays: retentionDays(env.CLEANUP_DOCUMENT_VERSIONS_DAYS, DEFAULT_DOCUMENT_VERSIONS_RETENTION_DAYS),
    documentVersionsKeep: positiveInteger(env.CLEANUP_DOCUMENT_VERSIONS_KEEP, DEFAULT_DOCUMENT_VERSIONS_KEEP),
    batchSize: positiveInteger(env.CLEANUP_BATCH_SIZE, DEFAULT_BATCH_SIZE, 1_000) || DEFAULT_BATCH_SIZE,
    maxBatches: positiveInteger(env.CLEANUP_MAX_BATCHES, DEFAULT_MAX_BATCHES, 100) || DEFAULT_MAX_BATCHES,
  };
}

function countFromRow(row) {
  return Number(row?.count || 0);
}

async function countEligible(env, query, values) {
  const row = await env.DB.prepare(query).bind(...values).first();
  return countFromRow(row);
}

async function deleteInBatches(env, query, values, batchSize, maxBatches) {
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await env.DB.prepare(query).bind(...values, batchSize).run();
    const changes = Number(result?.meta?.changes || 0);
    deleted += changes;
    if (changes < batchSize) break;
  }
  return deleted;
}

function cutoff(now, days) {
  return now - days * DAY_MS;
}

export async function cleanupDatabase(env, { now = Date.now(), dryRun = false } = {}) {
  if (!env.DB) throw new Error("DB binding is not configured");
  const config = getCleanupConfig(env);
  const submissionsCutoff = cutoff(now, config.submissionsDays);
  const auditLogsCutoff = cutoff(now, config.auditLogsDays);
  const documentVersionsCutoff = cutoff(now, config.documentVersionsDays);

  const submissionsWhere = "status IN ('approved', 'rejected', 'withdrawn') AND created_at < ?1";
  const auditLogsWhere = "created_at < ?1";
  const documentVersionsWhere = `created_at < ?1
    AND id NOT IN (
      SELECT id FROM document_versions
      ORDER BY created_at DESC, id DESC
      LIMIT ?2
    )`;

  const eligible = {
    submissions: await countEligible(env, `SELECT COUNT(*) AS count FROM submissions WHERE ${submissionsWhere}`, [submissionsCutoff]),
    auditLogs: await countEligible(env, `SELECT COUNT(*) AS count FROM audit_logs WHERE ${auditLogsWhere}`, [auditLogsCutoff]),
    documentVersions: await countEligible(
      env,
      `SELECT COUNT(*) AS count FROM document_versions WHERE ${documentVersionsWhere}`,
      [documentVersionsCutoff, config.documentVersionsKeep],
    ),
  };

  if (dryRun) return { dryRun: true, config, eligible, deleted: { submissions: 0, auditLogs: 0, documentVersions: 0 } };

  const deleted = {
    submissions: await deleteInBatches(
      env,
      `DELETE FROM submissions
       WHERE id IN (
         SELECT id FROM submissions
         WHERE ${submissionsWhere}
         ORDER BY created_at ASC, id ASC
         LIMIT ?2
       )`,
      [submissionsCutoff],
      config.batchSize,
      config.maxBatches,
    ),
    auditLogs: await deleteInBatches(
      env,
      `DELETE FROM audit_logs
       WHERE id IN (
         SELECT id FROM audit_logs
         WHERE ${auditLogsWhere}
         ORDER BY created_at ASC, id ASC
         LIMIT ?2
       )`,
      [auditLogsCutoff],
      config.batchSize,
      config.maxBatches,
    ),
    documentVersions: await deleteInBatches(
      env,
      `DELETE FROM document_versions
       WHERE id IN (
         SELECT id FROM document_versions
         WHERE ${documentVersionsWhere}
         ORDER BY created_at ASC, id ASC
         LIMIT ?3
       )`,
      [documentVersionsCutoff, config.documentVersionsKeep],
      config.batchSize,
      config.maxBatches,
    ),
  };

  return { dryRun: false, config, eligible, deleted };
}

function jsonResponse(request, body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Access-Control-Allow-Origin", new URL(request.url).origin);
  return new Response(JSON.stringify(body), { ...init, headers });
}

export async function handleAdminCleanup(request, env) {
  if (!env.ADMIN_TOKEN) return jsonResponse(request, { error: "ADMIN_TOKEN is not configured" }, { status: 503 });
  if (!(await hasAdminAccess(request, env))) return jsonResponse(request, { error: "Invalid admin session" }, { status: 401 });

  let dryRun = false;
  if (request.method === "POST") {
    const raw = await request.text();
    if (raw.trim()) {
      try {
        const body = JSON.parse(raw);
        dryRun = body?.dryRun === true;
      } catch {
        return jsonResponse(request, { error: "Request body is not valid JSON" }, { status: 400 });
      }
    }
  }

  try {
    const result = await cleanupDatabase(env, { dryRun });
    if (!dryRun) {
      await writeAuditLog(env, {
        actorId: "admin",
        action: "database-cleanup",
        details: result.deleted,
      });
    }
    return jsonResponse(request, { ok: true, ...result });
  } catch (error) {
    return jsonResponse(request, { error: error.message || "Database cleanup failed" }, { status: 500 });
  }
}

export function handleCleanupOptions(request) {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Origin": new URL(request.url).origin,
    },
  });
}
