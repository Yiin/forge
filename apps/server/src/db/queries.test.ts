import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate } from './migrate.js'
import {
  appendMessage,
  createProject,
  createSession,
  replaySince,
} from './queries.js'

const dbs: DatabaseSync[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})
function fixture() {
  const db = new DatabaseSync(':memory:')
  dbs.push(db)
  migrate(db)
  const project = createProject(db, { name: 'Forge', path: '/tmp/forge' })
  const session = createSession(db, {
    projectId: project.id,
    harness: 'default',
    title: 'Chat',
    cwd: '/tmp',
  })
  return { db, session }
}
const message = (
  sessionId: string,
  type: string,
  content: unknown,
  seq = 1,
) => ({
  sessionId,
  turnId: 'turn-1',
  itemId: 'item-1',
  role: 'agent' as const,
  type,
  content,
  createdAt: seq,
})

describe('database queries', () => {
  it('appends rows in global sequence and replays after a cursor', () => {
    const { db, session } = fixture()
    appendMessage(db, message(session.id, 'text_delta', { text: 'hello' }))
    appendMessage(db, {
      ...message(session.id, 'turn_end', {}),
      itemId: 'end',
      createdAt: 2,
    })
    expect(replaySince(db, 0, [session.id])).toHaveLength(2)
    expect(
      (replaySince(db, 1, [session.id]) as Array<{ seq: number }>).map(
        (row) => row.seq,
      ),
    ).toEqual([2])
  })
  it('folds text deltas into FTS only when the turn ends', () => {
    const { db, session } = fixture()
    appendMessage(
      db,
      message(session.id, 'text_delta', { text: 'searchable phrase' }),
    )
    expect(
      db
        .prepare(
          "SELECT count(*) AS count FROM messages_fts WHERE messages_fts MATCH 'searchable'",
        )
        .get(),
    ).toEqual({ count: 0 })
    appendMessage(db, {
      ...message(session.id, 'turn_end', {}),
      itemId: 'end',
      createdAt: 2,
    })
    expect(
      (
        db
          .prepare(
            "SELECT count(*) AS count FROM messages_fts WHERE messages_fts MATCH 'searchable'",
          )
          .get() as { count: number }
      ).count,
    ).toBe(1)
  })
  it('uses the session and sequence index for scoped replay', () => {
    const { db, session } = fixture()
    const plan = db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT * FROM messages WHERE seq > ? AND session_id IN (?) ORDER BY seq LIMIT ?',
      )
      .all(0, session.id, 10) as Array<{ detail: string }>
    expect(
      plan.some((row) => row.detail.includes('messages_session_seq_idx')),
    ).toBe(true)
  })
  it('keeps message queries free of UPDATE and DELETE statements', () => {
    const source = readFileSync(
      new URL('./queries.ts', import.meta.url),
      'utf8',
    )
    expect(source).not.toMatch(/\b(?:UPDATE|DELETE)\s+messages\b/i)
  })
  it('uses the required id prefixes', () => {
    const { db, session } = fixture()
    expect(createProject(db, { name: 'Other', path: '/tmp' }).id).toMatch(
      /^prj_/,
    )
    expect(session.id).toMatch(/^ses_/)
  })
})
