-- Snippets require stored text. Rebuild the derived indexes from their source rows.
DROP TRIGGER IF EXISTS messages_fts_insert;
DROP TRIGGER IF EXISTS sessions_fts_insert;
DROP TRIGGER IF EXISTS sessions_fts_update;
DROP TABLE IF EXISTS messages_fts;
DROP TABLE IF EXISTS sessions_fts;

-- Search indexes contain only finalized message items. Delta rows are not indexed.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, item_id UNINDEXED, seq UNINDEXED
);
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  title, session_id UNINDEXED
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

INSERT INTO messages_fts(rowid, text)
SELECT seq, COALESCE(json_extract(content, '$.text'), json_extract(content, '$.output'), '')
FROM messages WHERE type IN ('text', 'tool_result');
INSERT INTO sessions_fts(rowid, title)
SELECT rowid, COALESCE(title, '') FROM sessions;

INSERT INTO messages_fts(rowid, text, item_id, seq)
SELECT first_seq, text, item_id, first_seq FROM (
  SELECT MIN(seq) AS first_seq, item_id, GROUP_CONCAT(text, '') AS text
  FROM (
    SELECT m.seq, m.item_id, m.session_id, m.turn_id,
      CASE WHEN json_type(m.content) = 'text' THEN json_extract(m.content, '$')
        ELSE COALESCE(json_extract(m.content, '$.text'), '') END AS text
    FROM messages m
    WHERE m.type = 'text_delta' AND EXISTS (
      SELECT 1 FROM messages ended
      WHERE ended.session_id = m.session_id AND ended.turn_id = m.turn_id
        AND ended.type = 'turn_end'
    )
    ORDER BY m.seq
  ) GROUP BY session_id, turn_id
) WHERE text <> '';
