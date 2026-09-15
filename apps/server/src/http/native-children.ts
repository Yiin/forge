import { Hono } from 'hono'
import type { DatabaseSync } from 'node:sqlite'

export function nativeChildRoutes(db: DatabaseSync) {
  const app = new Hono()
  app.get('/api/sessions/:id/native-children/:childId/messages', (c) => {
    const sessionId = c.req.param('id'),
      childId = c.req.param('childId')
    const after = Number(c.req.query('after') ?? 0),
      limit = Number(c.req.query('limit') ?? 200)
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      return c.json({ error: 'Invalid native child page' }, 400)
    const session = db
      .prepare(
        `SELECT s.id FROM sessions s LEFT JOIN projects p ON p.id=s.project_id
      WHERE s.id=? AND s.deleted_at IS NULL AND (s.project_id IS NULL OR (p.id IS NOT NULL AND p.deleted_at IS NULL))`,
      )
      .get(sessionId)
    if (!session) return c.json({ error: 'Native child not found' }, 404)
    const known = db
      .prepare(
        `SELECT 1 FROM messages WHERE session_id=? AND
      (json_extract(content,'$.nativeChildId')=? OR json_extract(content,'$.childId')=?) LIMIT 1`,
      )
      .get(sessionId, childId, childId)
    if (!known) return c.json({ error: 'Native child not found' }, 404)
    const sizes = db
      .prepare(
        `SELECT seq,length(CAST(content AS BLOB))+6*(length(CAST(session_id AS BLOB))+length(CAST(turn_id AS BLOB))+length(CAST(item_id AS BLOB))+length(CAST(role AS BLOB))+length(CAST(type AS BLOB)))+256 AS bytes FROM messages
      WHERE session_id=? AND json_extract(content,'$.childId')=? AND seq>? ORDER BY seq LIMIT ?`,
      )
      .all(sessionId, childId, after, limit + 1) as Array<{
      seq: number
      bytes: number
    }>
    let bytes = 256,
      count = 0,
      through = after
    for (const row of sizes.slice(0, limit)) {
      if (bytes + row.bytes > 8 * 1024 * 1024) break
      bytes += row.bytes
      count++
      through = row.seq
    }
    if (sizes.length && !count)
      return c.json({ error: 'Native child message exceeds page limit' }, 413)
    const rows = db
      .prepare(
        `SELECT seq,session_id,turn_id,item_id,role,type,content,created_at FROM messages
      WHERE session_id=? AND json_extract(content,'$.childId')=? AND seq>? AND seq<=? ORDER BY seq`,
      )
      .all(sessionId, childId, after, through) as Array<{
      seq: number
      session_id: string
      turn_id: string
      item_id: string
      role: string
      type: string
      content: string
      created_at: number
    }>
    const hasMore = sizes.length > count
    const messages = rows.map((row) => ({
      seq: row.seq,
      sessionId: row.session_id,
      turnId: row.turn_id,
      itemId: row.item_id,
      role: row.role,
      type: row.type,
      content: JSON.parse(row.content),
      createdAt: new Date(row.created_at).toISOString(),
    }))
    return c.json({ messages, cursor: messages.at(-1)?.seq ?? after, hasMore })
  })
  return app
}
