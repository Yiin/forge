ALTER TABLE sessions ADD COLUMN fork_request_id TEXT;
ALTER TABLE sessions ADD COLUMN context_method TEXT;
ALTER TABLE sessions ADD COLUMN context_confidence TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_parent_fork_request_idx
  ON sessions(parent_session_id, fork_request_id)
  WHERE fork_request_id IS NOT NULL;
