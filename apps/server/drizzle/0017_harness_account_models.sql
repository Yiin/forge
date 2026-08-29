CREATE TABLE IF NOT EXISTS harness_account_models (
  account_id TEXT PRIMARY KEY,
  harness_key TEXT NOT NULL,
  models TEXT NOT NULL CHECK (json_valid(models)),
  source TEXT NOT NULL,
  warning TEXT,
  updated_at INTEGER NOT NULL
);
