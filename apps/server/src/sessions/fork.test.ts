import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { appendMessage, createProject, createSession } from '../db/queries.js'
import { migrate } from '../db/migrate.js'
import { createFork } from './fork.js'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

describe('conversation forks', () => {
  it('uses an exclusive edit boundary and an inclusive branch boundary', () => {
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
    appendMessage(db, {
      sessionId: session.id,
      turnId: 'turn',
      itemId: 'user',
      role: 'user',
      type: 'text_delta',
      content: { type: 'text_delta', text: 'old question' },
    })
    const source = appendMessage(db, {
      sessionId: session.id,
      turnId: 'turn',
      itemId: 'agent',
      role: 'agent',
      type: 'text_delta',
      content: { type: 'text_delta', text: 'old answer' },
    })
    const edit = createFork(db, {
      sessionId: session.id,
      messageSeq: source.seq,
      text: 'new question',
      requestId: 'edit',
      includeSource: false,
    })
    const branch = createFork(db, {
      sessionId: session.id,
      messageSeq: source.seq,
      text: 'continue',
      requestId: 'branch',
      includeSource: true,
    })
    expect(edit.boundary).toBe(source.seq - 1)
    expect(branch.boundary).toBe(source.seq)
    expect(edit.recap).toContain('old question')
    expect(edit.recap).not.toContain('old answer')
    expect(branch.recap).toContain('old answer')
  })

  it('returns the same child for a repeated request key', () => {
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
    const source = appendMessage(db, {
      sessionId: session.id,
      turnId: 'turn',
      itemId: 'user',
      role: 'user',
      type: 'text_delta',
      content: { type: 'text_delta', text: 'question' },
    })
    const input = {
      sessionId: session.id,
      messageSeq: source.seq,
      text: 'edit',
      requestId: 'same',
      includeSource: false,
    }
    const first = createFork(db, input)
    const second = createFork(db, input)
    expect(second.existing).toBe(true)
    expect(second.childId).toBe(first.childId)
    expect(
      (
        db
          .prepare(
            'SELECT count(*) AS count FROM sessions WHERE parent_session_id = ?',
          )
          .get(session.id) as { count: number }
      ).count,
    ).toBe(1)
  })
})
