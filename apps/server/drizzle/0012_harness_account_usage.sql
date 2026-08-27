CREATE TABLE IF NOT EXISTS harness_account_usage (
  account_id TEXT NOT NULL,
  window_key TEXT NOT NULL,
  label TEXT NOT NULL,
  percent REAL NOT NULL CHECK (percent >= 0 AND percent <= 1),
  resets_at INTEGER,
  tier_label TEXT,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, window_key)
);

CREATE INDEX IF NOT EXISTS harness_account_usage_observed_at_idx
  ON harness_account_usage (observed_at);
