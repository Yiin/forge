CREATE TABLE IF NOT EXISTS acp_journals (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  account TEXT NOT NULL,
  journal_id TEXT NOT NULL UNIQUE,
  writer_epoch TEXT NOT NULL,
  committed_through INTEGER NOT NULL,
  prefix_hash TEXT NOT NULL,
  binding TEXT
);
CREATE TABLE IF NOT EXISTS acp_transactions (
  transaction_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  through_ordinal INTEGER NOT NULL,
  value TEXT NOT NULL,
  acknowledgement TEXT NOT NULL,
  UNIQUE(session_id, through_ordinal)
);
CREATE TABLE IF NOT EXISTS acp_records (
  record_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  admission_ordinal INTEGER NOT NULL,
  record_index INTEGER NOT NULL,
  value TEXT NOT NULL,
  UNIQUE(session_id, admission_ordinal, record_index)
);
CREATE TABLE IF NOT EXISTS acp_artifacts (
  artifact_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  purpose TEXT NOT NULL,
  mime TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS acp_replay_snapshots (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  binding_hash TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  load_id TEXT NOT NULL,
  local_turn_id TEXT NOT NULL,
  PRIMARY KEY(session_id,binding_hash,fingerprint)
);
CREATE INDEX IF NOT EXISTS messages_native_child_page
  ON messages(session_id,json_extract(content,'$.childId'),seq);
CREATE INDEX IF NOT EXISTS messages_native_child_subject
  ON messages(session_id,json_extract(content,'$.nativeChildId'),seq);
CREATE TABLE IF NOT EXISTS acp_replay_native_items (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  binding_hash TEXT NOT NULL,
  native_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY(session_id,binding_hash,native_key)
);
CREATE INDEX IF NOT EXISTS acp_records_native_tool
  ON acp_records(session_id,json_extract(value,'$.value.event.toolCallId'));
CREATE INDEX IF NOT EXISTS acp_records_native_item
  ON acp_records(session_id,json_extract(value,'$.value.event.providerItemId'));
