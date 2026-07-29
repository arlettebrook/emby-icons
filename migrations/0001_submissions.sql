CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending', 'approving', 'approved', 'rejected', 'withdrawn')),
  submitter_token_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  reviewer_id TEXT,
  reviewer_note TEXT,
  reviewed_at INTEGER
);

CREATE INDEX IF NOT EXISTS submissions_status_created_idx
  ON submissions (status, created_at DESC);

CREATE INDEX IF NOT EXISTS submissions_ip_created_idx
  ON submissions (ip_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_logs_target_created_idx
  ON audit_logs (target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS document_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_json TEXT NOT NULL,
  etag TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS document_versions_created_idx
  ON document_versions (created_at DESC);

CREATE TABLE IF NOT EXISTS document_publish_lock (
  lock_name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
