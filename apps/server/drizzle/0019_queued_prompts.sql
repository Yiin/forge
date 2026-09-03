CREATE TABLE IF NOT EXISTS queued_prompts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  text TEXT NOT NULL,
  attachment_ids TEXT,
  model TEXT,
  config_options TEXT,
  client_item_id TEXT,
  request_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS queued_prompts_session_idx
  ON queued_prompts(session_id, created_at, id);
