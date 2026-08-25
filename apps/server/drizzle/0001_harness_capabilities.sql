CREATE TABLE IF NOT EXISTS harness_capabilities (
  harness_key TEXT PRIMARY KEY,
  capabilities TEXT NOT NULL CHECK (json_valid(capabilities)),
  agent_name TEXT,
  updated_at INTEGER NOT NULL
);
