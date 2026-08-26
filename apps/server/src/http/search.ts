import { Hono } from 'hono'
import type { DatabaseSync } from 'node:sqlite'
import { ensureFtsSchema, ftsQuery } from '../search/fts.js'

export function searchRoutes(db: DatabaseSync) {
  ensureFtsSchema(db)
  const tableColumns = (table: string) =>
    new Set(
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => (row as { name: string }).name),
    )
  const messageColumns = tableColumns('messages')
  const sessionColumns = tableColumns('sessions')
  const runColumns = tableColumns('epic_runs')
  const app = new Hono()
  app.get('/api/search', (c) => {
    const q = c.req.query('q') ?? ''
    const scope = c.req.query('scope') ?? 'all'
    const limit = Math.min(
      Math.max(Number(c.req.query('limit') ?? 20) || 20, 1),
      100,
    )
    const match = ftsQuery(q)
    const empty = { sessions: [], messages: [], runs: [] }
    if (!match) return c.json(empty)
    const result: typeof empty = { sessions: [], messages: [], runs: [] }
    const retentionFilter = sessionColumns.has('retention')
      ? " AND s.retention = 'permanent'"
      : ''
    if (
      (scope === 'all' || scope === 'sessions') &&
      sessionColumns.has('title')
    )
      result.sessions = db
        .prepare(
          `
        SELECT s.id AS sessionId, COALESCE(s.title, '') AS title,
          snippet(sessions_fts, -1, '<mark>', '</mark>', '…', 32) AS snippet
        FROM sessions_fts JOIN sessions s ON s.rowid = sessions_fts.rowid
        WHERE sessions_fts MATCH ?${retentionFilter} ORDER BY bm25(sessions_fts) LIMIT ?
      `,
        )
        .all(match, limit) as typeof result.sessions
    if (scope === 'all' || scope === 'messages')
      result.messages = db
        .prepare(
          `
        SELECT m.session_id AS sessionId, m.seq,
          ${messageColumns.has('item_id') ? 'COALESCE(m.item_id, CAST(m.seq AS TEXT))' : 'CAST(m.seq AS TEXT)'} AS itemId,
          snippet(messages_fts, -1, '<mark>', '</mark>', '…', 32) AS snippet,
          ${sessionColumns.has('title') ? "COALESCE(s.title, '')" : "''"} AS sessionTitle
        FROM messages_fts JOIN messages m ON m.seq = messages_fts.rowid
          LEFT JOIN sessions s ON s.id = m.session_id
        WHERE messages_fts MATCH ?${retentionFilter} ORDER BY bm25(messages_fts) LIMIT ?
      `,
        )
        .all(match, limit) as typeof result.messages
    if ((scope === 'all' || scope === 'runs') && runColumns.has('epic_bead_id'))
      result.runs = db
        .prepare(
          `
        SELECT r.id AS runId,
          ${runColumns.has('title') ? "COALESCE(r.title, r.epic_bead_id, '')" : "COALESCE(r.epic_bead_id, '')"} AS title,
          snippet(epic_runs_fts, -1, '<mark>', '</mark>', '…', 32) AS snippet, r.status
        FROM epic_runs_fts JOIN epic_runs r ON r.rowid = epic_runs_fts.rowid
        WHERE epic_runs_fts MATCH ? ORDER BY bm25(epic_runs_fts) LIMIT ?
      `,
        )
        .all(match, limit) as typeof result.runs
    return c.json(result)
  })
  return app
}
