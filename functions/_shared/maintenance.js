export const MAINTENANCE_STATE_KEY = "maintenance/last-cleanup";
export const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_RETENTION = {
  submissions: 180 * DAY_MS,
  auditLogs: 180 * DAY_MS,
  documentVersions: 90 * DAY_MS,
  submissionAttempts: 30 * DAY_MS,
  nameCheckAttempts: 2 * DAY_MS,
};
const KEEP_DOCUMENT_VERSIONS = 100;
const CLEANUP_INTERVAL = DAY_MS;

function changed(result) {
  return Number(result?.meta?.changes || 0);
}

async function cleanupStep(name, task) {
  try {
    return { name, changes: changed(await task()), error: null };
  } catch (error) {
    console.warn(`Periodic maintenance failed for ${name}`, error);
    return { name, changes: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Best-effort retention cleanup. It is deliberately non-throwing: a failed
 * maintenance query must never fail the request that happened to trigger it.
 */
export async function runPeriodicMaintenance(env, { now = Date.now(), force = false } = {}) {
  if (!env?.DB || !env?.EMBY_ICONS) return { skipped: true, reason: "bindings-unavailable" };

  try {
    const lastRun = Number(await env.EMBY_ICONS.get(MAINTENANCE_STATE_KEY));
    if (!force && Number.isFinite(lastRun) && lastRun > 0 && now - lastRun < CLEANUP_INTERVAL) {
      return { skipped: true, reason: "recently-run" };
    }
  } catch (error) {
    console.warn("Periodic maintenance could not read its KV marker", error);
    return { skipped: true, reason: "marker-unavailable" };
  }

  const submissionCutoff = now - DEFAULT_RETENTION.submissions;
  const auditCutoff = now - DEFAULT_RETENTION.auditLogs;
  const versionCutoff = now - DEFAULT_RETENTION.documentVersions;
  const submissionAttemptCutoff = now - DEFAULT_RETENTION.submissionAttempts;
  const nameCheckCutoff = now - DEFAULT_RETENTION.nameCheckAttempts;

  const steps = [];
  steps.push(await cleanupStep("submissions", () => env.DB.prepare(
    `DELETE FROM submissions
      WHERE status IN ('approved', 'rejected', 'withdrawn')
        AND COALESCE(reviewed_at, created_at) < ?1`,
  ).bind(submissionCutoff).run()));
  steps.push(await cleanupStep("audit-logs", () => env.DB.prepare(
    "DELETE FROM audit_logs WHERE created_at < ?1",
  ).bind(auditCutoff).run()));
  steps.push(await cleanupStep("document-versions", () => env.DB.prepare(
    `DELETE FROM document_versions
      WHERE created_at < ?1
        AND id NOT IN (
          SELECT id FROM document_versions
           ORDER BY created_at DESC, id DESC
           LIMIT ?2
        )`,
  ).bind(versionCutoff, KEEP_DOCUMENT_VERSIONS).run()));
  steps.push(await cleanupStep("submission-attempts", () => env.DB.prepare(
    "DELETE FROM submission_attempts WHERE created_at < ?1",
  ).bind(submissionAttemptCutoff).run()));
  steps.push(await cleanupStep("name-check-attempts", () => env.DB.prepare(
    "DELETE FROM name_check_attempts WHERE created_at < ?1",
  ).bind(nameCheckCutoff).run()));

  try {
    await env.EMBY_ICONS.put(MAINTENANCE_STATE_KEY, String(now));
  } catch (error) {
    console.warn("Periodic maintenance could not update its KV marker", error);
  }

  return {
    skipped: false,
    ranAt: now,
    changes: Object.fromEntries(steps.map((step) => [step.name, step.changes])),
    errors: steps.filter((step) => step.error).map((step) => ({ name: step.name, error: step.error })),
  };
}