CREATE TABLE IF NOT EXISTS submission_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS submission_attempts_ip_created_idx
  ON submission_attempts (ip_hash, created_at DESC);
