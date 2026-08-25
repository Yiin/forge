import type { DatabaseSync } from 'node:sqlite'

type TableInfo = { name: string }

function hasColumns(db: DatabaseSync, table: string, columns: string[]) {
  const present = new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => (row as TableInfo).name),
  )
  return columns.every((column) => present.has(column))
}

/** Install FTS5 objects. Finalized text means type=text or tool_result only. */
export function ensureFtsSchema(db: DatabaseSync) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text);
    CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(title);
    CREATE VIRTUAL TABLE IF NOT EXISTS epic_runs_fts USING fts5(epic_bead_id, error);
  `)
  if (hasColumns(db, 'messages', ['seq', 'type', 'content']))
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages
      WHEN NEW.type IN ('text', 'tool_result') BEGIN
        INSERT INTO messages_fts(rowid, text) VALUES
          (NEW.seq, COALESCE(json_extract(NEW.content, '$.text'), json_extract(NEW.content, '$.output'), ''));
      END;
    `)
  if (hasColumns(db, 'sessions', ['id', 'title']))
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS sessions_fts_insert AFTER INSERT ON sessions BEGIN
        INSERT INTO sessions_fts(rowid, title) VALUES (NEW.rowid, COALESCE(NEW.title, ''));
      END;
      CREATE TRIGGER IF NOT EXISTS sessions_fts_update AFTER UPDATE OF title ON sessions BEGIN
        DELETE FROM sessions_fts WHERE rowid = OLD.rowid;
        INSERT INTO sessions_fts(rowid, title) VALUES (NEW.rowid, COALESCE(NEW.title, ''));
      END;
    `)
  if (hasColumns(db, 'epic_runs', ['id', 'epic_bead_id', 'error']))
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS epic_runs_fts_insert AFTER INSERT ON epic_runs BEGIN
        INSERT INTO epic_runs_fts(rowid, epic_bead_id, error) VALUES
          (NEW.rowid, COALESCE(NEW.epic_bead_id, ''), COALESCE(NEW.error, ''));
      END;
      CREATE TRIGGER IF NOT EXISTS epic_runs_fts_update AFTER UPDATE OF epic_bead_id, error ON epic_runs BEGIN
        DELETE FROM epic_runs_fts WHERE rowid = OLD.rowid;
        INSERT INTO epic_runs_fts(rowid, epic_bead_id, error)
          VALUES (NEW.rowid, COALESCE(NEW.epic_bead_id, ''), COALESCE(NEW.error, ''));
      END;
    `)
  if (hasColumns(db, 'messages', ['seq', 'type', 'content']))
    db.exec(`
      INSERT INTO messages_fts(rowid, text)
      SELECT seq, COALESCE(json_extract(content, '$.text'), json_extract(content, '$.output'), '')
      FROM messages WHERE type IN ('text', 'tool_result')
        AND seq NOT IN (SELECT rowid FROM messages_fts);
    `)
  if (hasColumns(db, 'sessions', ['id', 'title']))
    db.exec(`
      INSERT INTO sessions_fts(rowid, title)
      SELECT rowid, COALESCE(title, '') FROM sessions
      WHERE rowid NOT IN (SELECT rowid FROM sessions_fts);
    `)
  if (hasColumns(db, 'epic_runs', ['id', 'epic_bead_id', 'error']))
    db.exec(`
      INSERT INTO epic_runs_fts(rowid, epic_bead_id, error)
      SELECT rowid, COALESCE(epic_bead_id, ''), COALESCE(error, '') FROM epic_runs
      WHERE rowid NOT IN (SELECT rowid FROM epic_runs_fts);
    `)
}

export function ftsQuery(input: string) {
  const tokens = input.trim().split(/\s+/).filter(Boolean)
  return tokens
    .map((token, index) => {
      const clean = token.replaceAll('"', '').replaceAll("'", '')
      if (!clean) return ''
      return `"${clean}"${index === tokens.length - 1 ? '*' : ''}`
    })
    .filter(Boolean)
    .join(' ')
}
