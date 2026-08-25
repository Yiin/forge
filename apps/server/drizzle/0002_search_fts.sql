-- Search indexes contain only finalized message items. Delta rows are not indexed.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text
);
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  title
);
CREATE VIRTUAL TABLE IF NOT EXISTS epic_runs_fts USING fts5(
  epic_bead_id, error
);

CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages
WHEN NEW.type IN ('text', 'tool_result')
BEGIN
  INSERT INTO messages_fts(rowid, text)
  VALUES (NEW.seq, COALESCE(json_extract(NEW.content, '$.text'), json_extract(NEW.content, '$.output'), ''));
END;
CREATE TRIGGER IF NOT EXISTS sessions_fts_insert AFTER INSERT ON sessions
BEGIN
  INSERT INTO sessions_fts(rowid, title) VALUES (NEW.rowid, COALESCE(NEW.title, ''));
END;
CREATE TRIGGER IF NOT EXISTS sessions_fts_update AFTER UPDATE OF title ON sessions
BEGIN
  DELETE FROM sessions_fts WHERE rowid = OLD.rowid;
  INSERT INTO sessions_fts(rowid, title) VALUES (NEW.rowid, COALESCE(NEW.title, ''));
END;
CREATE TRIGGER IF NOT EXISTS epic_runs_fts_insert AFTER INSERT ON epic_runs
BEGIN
  INSERT INTO epic_runs_fts(rowid, epic_bead_id, error)
  VALUES (NEW.rowid, COALESCE(NEW.epic_bead_id, ''), COALESCE(NEW.error, ''));
END;
CREATE TRIGGER IF NOT EXISTS epic_runs_fts_update AFTER UPDATE OF epic_bead_id, error ON epic_runs
BEGIN
  DELETE FROM epic_runs_fts WHERE rowid = OLD.rowid;
  INSERT INTO epic_runs_fts(rowid, epic_bead_id, error)
  VALUES (NEW.rowid, COALESCE(NEW.epic_bead_id, ''), COALESCE(NEW.error, ''));
END;
