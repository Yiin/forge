-- sessions.project_id becomes nullable so a draft can promote against a bare
-- filesystem target instead of an invented project. SQLite cannot drop NOT NULL
-- in place, so the table is rebuilt with the documented procedure: build the
-- replacement, copy, drop the original, rename. Dropping first is what lets the
-- rename repoint `REFERENCES sessions(id)` in every child table back at the new
-- table. migrate() suspends foreign keys around this and runs
-- PRAGMA foreign_key_check before it commits.
--
-- rowid is copied because sessions_fts is keyed on it. Indexes and triggers
-- belong to the dropped table, so they are recreated after the rename, and
-- after the copy so the insert trigger cannot double-index existing rows.
CREATE TABLE sessions_project_optional (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  harness TEXT NOT NULL,
  title TEXT NOT NULL,
  cwd TEXT NOT NULL,
  worktree_path TEXT,
  provider_session_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('chat','subagent','epic_worker')),
  parent_session_id TEXT REFERENCES sessions_project_optional(id),
  forked_at_seq INTEGER,
  spawned_by_seq INTEGER,
  epic_run_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('idle','running','errored','archived')),
  auto_resume INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  user_titled INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  fork_request_id TEXT,
  context_method TEXT,
  context_confidence TEXT,
  retention TEXT NOT NULL DEFAULT 'permanent' CHECK (retention IN ('permanent','discardable')),
  account_id TEXT,
  model TEXT,
  branch TEXT,
  config_options TEXT,
  adapter_kind TEXT,
  native_resume_state TEXT NOT NULL DEFAULT 'not_eligible',
  native_resume_error TEXT
);
INSERT INTO sessions_project_optional (
  rowid, id, project_id, harness, title, cwd, worktree_path, provider_session_id,
  kind, parent_session_id, forked_at_seq, spawned_by_seq, epic_run_id, status,
  auto_resume, created_at, last_activity_at, user_titled, deleted_at,
  fork_request_id, context_method, context_confidence, retention, account_id,
  model, branch, config_options, adapter_kind, native_resume_state,
  native_resume_error
)
SELECT
  rowid, id, project_id, harness, title, cwd, worktree_path, provider_session_id,
  kind, parent_session_id, forked_at_seq, spawned_by_seq, epic_run_id, status,
  auto_resume, created_at, last_activity_at, user_titled, deleted_at,
  fork_request_id, context_method, context_confidence, retention, account_id,
  model, branch, config_options, adapter_kind, native_resume_state,
  native_resume_error
FROM sessions;
DROP TRIGGER IF EXISTS sessions_fts_insert;
DROP TRIGGER IF EXISTS sessions_fts_update;
DROP TABLE sessions;
ALTER TABLE sessions_project_optional RENAME TO sessions;

CREATE UNIQUE INDEX IF NOT EXISTS sessions_parent_fork_request_idx
  ON sessions(parent_session_id, fork_request_id)
  WHERE fork_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sessions_retention_idx ON sessions(retention);
CREATE TRIGGER IF NOT EXISTS sessions_fts_insert AFTER INSERT ON sessions BEGIN INSERT INTO sessions_fts(rowid, title, session_id) VALUES (new.rowid, new.title, new.id); END;
CREATE TRIGGER IF NOT EXISTS sessions_fts_update AFTER UPDATE OF title ON sessions
BEGIN
  DELETE FROM sessions_fts WHERE rowid = OLD.rowid;
  INSERT INTO sessions_fts(rowid, title) VALUES (NEW.rowid, COALESCE(NEW.title, ''));
END;
