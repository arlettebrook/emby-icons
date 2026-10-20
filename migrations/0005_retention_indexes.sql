CREATE INDEX IF NOT EXISTS audit_logs_created_idx
  ON audit_logs (created_at);

CREATE INDEX IF NOT EXISTS submission_attempts_created_idx
  ON submission_attempts (created_at);

CREATE INDEX IF NOT EXISTS name_check_attempts_created_idx
  ON name_check_attempts (created_at);

CREATE INDEX IF NOT EXISTS document_versions_created_id_idx
  ON document_versions (created_at, id);