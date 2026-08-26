ALTER TABLE sessions ADD COLUMN retention TEXT NOT NULL DEFAULT 'permanent' CHECK (retention IN ('permanent','discardable'));
CREATE INDEX IF NOT EXISTS sessions_retention_idx ON sessions(retention);
