import { appendMessage } from '../db/queries.js'
import type { EventBus } from '../events/bus.js'
import type { SessionManager, SessionRow } from './manager.js'

type Db = {
  exec(sql: string): unknown
  prepare(sql: string): {
    all(...args: unknown[]): any[]
    get(...args: unknown[]): any
    run(...args: unknown[]): unknown
  }
}

const id = (prefix: string) =>
  `${prefix}${crypto.randomUUID().replaceAll('-', '')}`

function recap(db: Db, sessionId: string) {
  const rows = db
    .prepare(
      `SELECT role, type, content FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT 30`,
    )
    .all(sessionId) as Array<{ role: string; type: string; content: string }>
  const prompt = rows.find(
    (row) =>
      row.role === 'user' &&
      row.type === 'text_delta' &&
      JSON.parse(row.content).text,
  )
  const tools = rows.filter(
    (row) => row.type === 'tool_call' || row.type === 'tool_result',
  ).length
  return `Last user prompt: ${prompt ? JSON.parse(prompt.content).text : '(none)'}. Tool events: ${tools}.`
}

export async function recoverSessions(
  db: Db,
  manager: SessionManager,
  bus: EventBus,
) {
  db.prepare(
    "UPDATE sessions SET status = 'archived' WHERE retention = 'discardable' AND status != 'archived'",
  ).run()
  const running = db
    .prepare("SELECT * FROM sessions WHERE status = 'running'")
    .all()
  for (const row of running) {
    const turn = db
      .prepare(
        "SELECT turn_id FROM messages WHERE session_id = ? AND type = 'turn_start' ORDER BY seq DESC LIMIT 1",
      )
      .get(row.id) as { turn_id?: string } | undefined
    appendMessage(db, {
      sessionId: row.id,
      turnId: turn?.turn_id ?? id('turn_'),
      itemId: id('item_'),
      role: 'system',
      type: 'turn_interrupted',
      content: { type: 'turn_interrupted', reason: 'server_restart' },
      eventBus: bus,
    })
    db.prepare(
      'UPDATE sessions SET status = ?, last_activity_at = ? WHERE id = ?',
    ).run('idle', Date.now(), row.id)
  }
  // Only sessions that were active when the process stopped need recovery.
  // Idle auto-resume sessions must wait for the user's next prompt.
  const candidates = running.filter(
    (row) => row.kind === 'chat' && row.auto_resume === 1,
  )
  for (const row of candidates) {
    try {
      const session = row as SessionRow
      await manager.recover(
        session,
        manager.canLoad(session) ? undefined : recap(db, row.id),
      )
    } catch (error) {
      db.prepare(
        'UPDATE sessions SET status = ?, last_activity_at = ? WHERE id = ?',
      ).run('errored', Date.now(), row.id)
      appendMessage(db, {
        sessionId: row.id,
        turnId: id('turn_'),
        itemId: id('item_'),
        role: 'system',
        type: 'error',
        content: {
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        },
        eventBus: bus,
      })
    }
  }
  const queued = db
    .prepare('SELECT DISTINCT session_id FROM queued_prompts')
    .all() as Array<{ session_id: string }>
  for (const row of queued) await manager.drainQueuedPrompt(row.session_id)
}
