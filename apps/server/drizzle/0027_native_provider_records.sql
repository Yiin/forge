CREATE TABLE IF NOT EXISTS native_provider_state (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (session_id, provider, name)
);

CREATE TABLE IF NOT EXISTS native_provider_records (
  position INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  record_key TEXT NOT NULL,
  value TEXT NOT NULL,
  UNIQUE (session_id, provider, record_key)
);
