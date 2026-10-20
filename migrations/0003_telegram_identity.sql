ALTER TABLE submissions ADD COLUMN telegram_user_id INTEGER;
ALTER TABLE submissions ADD COLUMN telegram_username TEXT;
ALTER TABLE submissions ADD COLUMN result_notified_at INTEGER;

CREATE INDEX IF NOT EXISTS submissions_telegram_user_created_idx
  ON submissions (telegram_user_id, created_at DESC);
