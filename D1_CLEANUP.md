# D1 cleanup

The Pages Functions do not run scheduled jobs by themselves. This project therefore
provides both a protected manual endpoint and a separate Cron Worker.

## Retention defaults

- Finalized submissions (`approved`, `rejected`, `withdrawn`) older than 180 days are deleted.
- Audit logs older than 365 days are deleted.
- Document snapshots older than 365 days are deleted, while the newest 20 snapshots are kept.
- Each run deletes at most 10 batches of 100 rows per table.
- `pending` and `approving` submissions are never removed by this job.

Configure these variables in the Pages project and in the Cron Worker when needed:

`CLEANUP_SUBMISSIONS_DAYS`, `CLEANUP_AUDIT_LOGS_DAYS`,
`CLEANUP_DOCUMENT_VERSIONS_DAYS`, `CLEANUP_DOCUMENT_VERSIONS_KEEP`,
`CLEANUP_BATCH_SIZE`, and `CLEANUP_MAX_BATCHES`.

## Apply the migration

Run all migrations against the production database:

```powershell
npx wrangler d1 migrations apply <database-name> --remote --config wrangler.cleanup.toml
```

The second migration adds indexes used by the cleanup queries.

## Manual cleanup

Preview eligible rows without deleting anything:

```powershell
Invoke-RestMethod -Method Post `
  -Uri https://<your-domain>/api/admin/cleanup `
  -Headers @{ Authorization = "Bearer <ADMIN_TOKEN>" } `
  -ContentType "application/json" `
  -Body '{"dryRun":true}'
```

Run the cleanup:

```powershell
Invoke-RestMethod -Method Post `
  -Uri https://<your-domain>/api/admin/cleanup `
  -Headers @{ Authorization = "Bearer <ADMIN_TOKEN>" }
```

The endpoint accepts the same admin session cookie as the admin panel.

## Automatic cleanup

Copy `wrangler.cleanup.example.toml`, replace the D1 database name and ID, then deploy
the Worker:

```powershell
Copy-Item wrangler.cleanup.example.toml wrangler.cleanup.toml
# Edit wrangler.cleanup.toml
npx wrangler deploy --config wrangler.cleanup.toml
```

The example runs daily at 03:00 UTC. The Worker must bind the same D1 database using
the binding name `DB`. After deployment, change the Cron schedule in the Cloudflare
Dashboard or in the Worker configuration if required.
