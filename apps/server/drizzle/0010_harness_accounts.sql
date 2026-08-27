CREATE TABLE IF NOT EXISTS harness_accounts (
  id TEXT PRIMARY KEY,
  harness_key TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  home_path TEXT NOT NULL,
  order_index INTEGER NOT NULL DEFAULT 0,
  disabled_at INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

ALTER TABLE sessions ADD COLUMN account_id TEXT;
ALTER TABLE epic_iterations ADD COLUMN account_id TEXT;
