CREATE TABLE IF NOT EXISTS workspace_target_revisions (
  target_key TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  checkout_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  revision INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS workspace_target_revisions_checkout ON workspace_target_revisions(checkout_key);
