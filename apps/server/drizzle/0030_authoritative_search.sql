CREATE INDEX IF NOT EXISTS messages_search_item
 ON messages(session_id,turn_id,item_id,json_extract(content,'$.childId'),seq);

-- One projection defines both backfill and updates. Snapshot text replaces the
-- earlier text for the same item and child; later deltas extend that snapshot.
CREATE VIEW IF NOT EXISTS authoritative_message_search AS
SELECT session_id,turn_id,item_id,child_id,MIN(seq) AS anchor,
 group_concat(CASE WHEN seq >= snapshot_seq THEN text ELSE '' END,'' ORDER BY seq) AS text
FROM (
 SELECT m.session_id,m.turn_id,m.item_id,m.seq,json_extract(m.content,'$.childId') AS child_id,
  COALESCE(json_extract(m.content,'$.text'),'') AS text,
  COALESCE((SELECT MAX(s.seq) FROM messages s
   WHERE s.session_id=m.session_id AND s.turn_id=m.turn_id AND s.item_id=m.item_id
    AND json_extract(s.content,'$.childId') IS json_extract(m.content,'$.childId')
    AND s.type='content_snapshot' AND json_extract(s.content,'$.contentType')='text'),0) AS snapshot_seq
 FROM messages m WHERE m.type='text_delta'
  OR (m.type='content_snapshot' AND json_extract(m.content,'$.contentType')='text')
)
GROUP BY session_id,turn_id,item_id,child_id;

DROP TRIGGER IF EXISTS messages_authoritative_search;
CREATE TRIGGER messages_authoritative_search AFTER INSERT ON messages
WHEN NEW.type='turn_end' OR (NEW.type='content_snapshot' AND json_extract(NEW.content,'$.contentType')='text')
BEGIN
 DELETE FROM messages_fts WHERE rowid IN (
  SELECT seq FROM messages WHERE session_id=NEW.session_id AND turn_id=NEW.turn_id
   AND (type='text_delta' OR (type='content_snapshot' AND json_extract(content,'$.contentType')='text'))
 );
 INSERT INTO messages_fts(rowid,text,item_id,seq)
 SELECT anchor,text,item_id,anchor FROM authoritative_message_search
 WHERE session_id=NEW.session_id AND turn_id=NEW.turn_id AND text<>'';
END;

CREATE TRIGGER IF NOT EXISTS sessions_fts_delete AFTER DELETE ON sessions BEGIN
 DELETE FROM sessions_fts WHERE rowid=OLD.rowid;
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
 DELETE FROM messages_fts WHERE rowid=OLD.seq OR rowid IN (
  SELECT seq FROM messages WHERE session_id=OLD.session_id AND turn_id=OLD.turn_id
   AND item_id=OLD.item_id AND json_extract(content,'$.childId') IS json_extract(OLD.content,'$.childId')
   AND (type='text_delta' OR (type='content_snapshot' AND json_extract(content,'$.contentType')='text'))
 );
 INSERT INTO messages_fts(rowid,text,item_id,seq)
 SELECT a.anchor,a.text,a.item_id,a.anchor FROM authoritative_message_search a
 WHERE a.session_id=OLD.session_id AND a.turn_id=OLD.turn_id AND a.item_id=OLD.item_id
  AND a.child_id IS json_extract(OLD.content,'$.childId') AND a.text<>''
  AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id=a.session_id AND m.turn_id=a.turn_id
   AND (m.type IN ('turn_end','content_snapshot') OR json_type(m.content,'$.imported') IS NOT NULL));
END;
CREATE TRIGGER IF NOT EXISTS epic_runs_fts_delete AFTER DELETE ON epic_runs BEGIN
 DELETE FROM epic_runs_fts WHERE rowid=OLD.rowid;
END;

DELETE FROM sessions_fts WHERE rowid NOT IN (SELECT rowid FROM sessions);
DELETE FROM epic_runs_fts WHERE rowid NOT IN (SELECT rowid FROM epic_runs);
DELETE FROM messages_fts WHERE rowid NOT IN (SELECT seq FROM messages)
 OR rowid IN (SELECT seq FROM messages WHERE type IN ('text_delta','content_snapshot'));
INSERT INTO messages_fts(rowid,text,item_id,seq)
SELECT a.anchor,a.text,a.item_id,a.anchor FROM authoritative_message_search a
WHERE a.text<>'' AND EXISTS (SELECT 1 FROM messages m
 WHERE m.session_id=a.session_id AND m.turn_id=a.turn_id
 AND (m.type IN ('turn_end','content_snapshot') OR json_type(m.content,'$.imported') IS NOT NULL));
