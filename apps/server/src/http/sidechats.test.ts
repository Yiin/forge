import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { appendMessage, createProject, createSession } from '../db/queries.js'
import { migrate } from '../db/migrate.js'
import { createFork } from '../sessions/fork.js'
import type { SessionManager } from '../sessions/manager.js'
import { sideChatRoutes } from './sidechats.js'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function fixture() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  migrate(db)
  const project = createProject(db, { name: 'Project', path: '/tmp/project' })
  const session = createSession(db, {
    projectId: project.id,
    harness: 'fake',
    cwd: '/tmp/project',
    title: 'Chat',
  })
  const message = appendMessage(db, {
    sessionId: session.id,
    turnId: 'turn',
    itemId: 'agent',
    role: 'agent',
    type: 'text_delta',
    content: { type: 'text_delta', text: 'answer' },
  })
  return { db, session, message }
}

describe('side chats', () => {
  it('marks a btw fork discardable and hides it from the session list', () => {
    const { db, session, message } = fixture()
    const context = createFork(db, {
      sessionId: session.id,
      messageSeq: message.seq,
      text: 'quick aside',
      requestId: 'btw',
      includeSource: true,
      retention: 'discardable',
    })
    const child = db
      .prepare('SELECT retention FROM sessions WHERE id = ?')
      .get(context.childId) as { retention: string }
    expect(child.retention).toBe('discardable')
    const listed = db
      .prepare(
        "SELECT id FROM sessions WHERE deleted_at IS NULL AND retention = 'permanent'",
      )
      .all() as { id: string }[]
    expect(listed.map((row) => row.id)).toEqual([session.id])
  })

  it('routes keep and discard through the manager', async () => {
    const calls: string[] = []
    const manager = {
      keep: (id: string) => {
        calls.push(`keep:${id}`)
        return id === 'ses_known'
      },
      discard: async (id: string) => {
        calls.push(`discard:${id}`)
        return id === 'ses_known'
      },
    } as unknown as SessionManager
    const app = sideChatRoutes(manager)
    const post = (path: string) => app.request(path, { method: 'POST' })

    expect((await post('/api/sessions/ses_known/keep')).status).toBe(200)
    expect((await post('/api/sessions/ses_gone/keep')).status).toBe(404)
    expect((await post('/api/sessions/ses_known/discard')).status).toBe(200)
    expect((await post('/api/sessions/ses_gone/discard')).status).toBe(404)
    expect(calls).toEqual([
      'keep:ses_known',
      'keep:ses_gone',
      'discard:ses_known',
      'discard:ses_gone',
    ])
  })

  it('rejects a btw request with no text', async () => {
    const app = sideChatRoutes({} as unknown as SessionManager)
    const response = await app.request('/api/sessions/ses_known/btw', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    })
    expect(response.status).toBe(400)
  })
})
