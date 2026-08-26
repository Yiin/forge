CREATE TABLE IF NOT EXISTS epic_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  epic_bead_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'completed', 'failed', 'cancelled')),
  mode TEXT NOT NULL CHECK (mode IN ('pool', 'serial')),
  worker_count INTEGER NOT NULL,
  base_branch TEXT NOT NULL,
  config TEXT NOT NULL CHECK (json_valid(config)),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS epic_iterations (
  id TEXT PRIMARY KEY,
  epic_run_id TEXT NOT NULL REFERENCES epic_runs(id),
  bead_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  worktree_path TEXT NOT NULL,
  branch TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'merged', 'failed', 'interrupted')),
  failure_reason TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
