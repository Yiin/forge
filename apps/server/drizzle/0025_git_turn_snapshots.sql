CREATE TABLE IF NOT EXISTS git_turn_snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  workspace_revision INTEGER NOT NULL,
  checkout_key TEXT NOT NULL,
  tree_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('ready', 'partial', 'unavailable')),
  error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, turn_id)
);
CREATE INDEX IF NOT EXISTS git_turn_snapshots_session_idx
  ON git_turn_snapshots(session_id, created_at);
