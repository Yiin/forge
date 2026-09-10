ALTER TABLE sessions ADD COLUMN adapter_kind TEXT;
ALTER TABLE sessions ADD COLUMN native_resume_state TEXT NOT NULL DEFAULT 'not_eligible';
ALTER TABLE sessions ADD COLUMN native_resume_error TEXT;
ALTER TABLE harness_accounts ADD COLUMN adapter_kind TEXT;

CREATE TABLE IF NOT EXISTS native_session_bindings (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  provider TEXT NOT NULL,
  account_id TEXT,
  cwd TEXT NOT NULL,
  provider_session_id TEXT,
  state TEXT NOT NULL DEFAULT 'available' CHECK (state IN ('available','failed','unavailable')),
  error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS native_bindings_identity_idx
  ON native_session_bindings(provider, account_id, cwd, provider_session_id);
