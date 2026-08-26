ALTER TABLE attachments RENAME TO attachments_legacy;
CREATE TABLE attachments (
  id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id), message_seq INTEGER REFERENCES messages(seq),
  filename TEXT NOT NULL, mime TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT, rel_path TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','complete','failed')), created_at INTEGER NOT NULL,
  draft_id TEXT, project_id TEXT
);
INSERT INTO attachments (id, session_id, message_seq, filename, mime, size_bytes, sha256, rel_path, status, created_at)
  SELECT id, session_id, message_seq, filename, mime, size_bytes, sha256, rel_path, status, created_at FROM attachments_legacy;
DROP TABLE attachments_legacy;
CREATE TABLE IF NOT EXISTS draft_promotions (
  draft_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES sessions(id)
);
