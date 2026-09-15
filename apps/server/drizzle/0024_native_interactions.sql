CREATE TABLE IF NOT EXISTS native_interactions (
  request_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  runtime_generation TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('permission', 'question')),
  request TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'replying', 'submitted', 'cancelled', 'expired', 'uncertain')),
  answer TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, request_id)
);
CREATE INDEX IF NOT EXISTS native_interactions_session_idx
  ON native_interactions(session_id, created_at);
