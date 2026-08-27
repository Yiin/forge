CREATE TABLE IF NOT EXISTS harness_account_limits (
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  harness_key TEXT NOT NULL,
  detected_at INTEGER NOT NULL,
  resets_at INTEGER,
  resets_at_estimated INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  detail TEXT,
  PRIMARY KEY (account_id, kind)
);
