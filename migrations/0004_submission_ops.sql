ALTER TABLE submissions ADD COLUMN source TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE submissions ADD COLUMN normalized_name TEXT;

-- Backfill existing rows with the closest SQLite-compatible normalization.
-- New writes always store the canonical normalizeIconName() result.
UPDATE submissions
   SET normalized_name = lower(trim(name))
 WHERE normalized_name IS NULL;

CREATE INDEX IF NOT EXISTS submissions_normalized_status_idx
  ON submissions (normalized_name, status);

CREATE INDEX IF NOT EXISTS submissions_source_created_idx
  ON submissions (source, created_at DESC);

CREATE INDEX IF NOT EXISTS submissions_reviewer_created_idx
  ON submissions (reviewer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS submissions_status_reviewed_idx
  ON submissions (status, reviewed_at);

CREATE TABLE IF NOT EXISTS name_check_attempts (
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS name_check_attempts_ip_created_idx
  ON name_check_attempts (ip_hash, created_at);
