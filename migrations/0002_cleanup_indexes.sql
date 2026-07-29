CREATE INDEX IF NOT EXISTS submissions_created_idx
  ON submissions (created_at);

CREATE INDEX IF NOT EXISTS audit_logs_created_idx
  ON audit_logs (created_at);
