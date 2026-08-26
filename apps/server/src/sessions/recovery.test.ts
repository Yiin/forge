import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.js'
import { appendMessage, createProject, createSession } from '../db/queries.js'
import { EventBus } from '../events/bus.js'
import { SessionManager } from './manager.js'
import { recoverSessions } from './recovery.js'
import type { HarnessProcess } from './harness.js'

function setup() {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const project = createProject(db, { name: 'test', path: '/tmp' })
  return { db, project, bus: new EventBus() }
}

describe('session recovery', () => {
  it('settles running sessions once and nudges a proven provider resume', async () => {
    const { db, project, bus } = setup()
    const session = createSession(db, {
      projectId: project.id,
      harness: 'fake',
      title: 'Chat',
      cwd: '/tmp',
    })
    db.prepare(
      "UPDATE sessions SET status = 'running', auto_resume = 1, provider_session_id = 'provider-1' WHERE id = ?",
    ).run(session.id)
    appendMessage(db, {
      sessionId: session.id,
      turnId: 'turn-1',
      itemId: 'item-1',
      role: 'user',
      type: 'turn_start',
      content: { type: 'turn_start' },
    })
    let nudges = 0
    const process: HarnessProcess = {
      capabilities: { loadSession: true },
      loadSession: async (_s, _item, _exit) => ({
        proven: true,
        handle: {
          prompt: async () => {
            nudges += 1
          },
          cancel() {},
          kill() {},
        },
      }),
      spawn: async () => {
        throw new Error('not used')
      },
    }
    const manager = new SessionManager(db, bus, () => process)
    await recoverSessions(db, manager, bus)
    expect(
      (
        db
          .prepare('SELECT status FROM sessions WHERE id = ?')
          .get(session.id) as { status: string }
      ).status,
    ).toBe('idle')
    expect(
      db
        .prepare(
          "SELECT count(*) AS count FROM messages WHERE session_id = ? AND type = 'turn_interrupted'",
        )
        .get(session.id),
    ).toEqual({ count: 1 })
    expect(nudges).toBe(1)
    await recoverSessions(db, manager, bus)
    expect(
      db
        .prepare(
          "SELECT count(*) AS count FROM messages WHERE session_id = ? AND type = 'turn_interrupted'",
        )
        .get(session.id),
    ).toEqual({ count: 1 })
  })

  it('does not nudge a provider load without proof', async () => {
    const { db, project, bus } = setup()
    const session = createSession(db, {
      projectId: project.id,
      harness: 'fake',
      title: 'Chat',
      cwd: '/tmp',
    })
    db.prepare(
      "UPDATE sessions SET status = 'running', auto_resume = 1, provider_session_id = 'provider-1' WHERE id = ?",
    ).run(session.id)
    let nudges = 0
    const process: HarnessProcess = {
      capabilities: { loadSession: true },
      loadSession: async () => ({
        proven: false,
        handle: {
          prompt: async () => {
            nudges += 1
          },
          cancel() {},
          kill() {},
        },
      }),
      spawn: async () => {
        throw new Error('not used')
      },
    }
    await recoverSessions(db, new SessionManager(db, bus, () => process), bus)
    expect(nudges).toBe(0)
    expect(
      (
        db
          .prepare('SELECT status FROM sessions WHERE id = ?')
          .get(session.id) as { status: string }
      ).status,
    ).toBe('errored')
  })

  it('falls back to recap when the provider rejects session load', async () => {
    const { db, project, bus } = setup()
    const session = createSession(db, {
      projectId: project.id,
      harness: 'fake',
      title: 'Chat',
      cwd: '/tmp',
    })
    db.prepare(
      "UPDATE sessions SET status = 'running', auto_resume = 1, provider_session_id = 'provider-1' WHERE id = ?",
    ).run(session.id)
    appendMessage(db, {
      sessionId: session.id,
      turnId: 'turn-1',
      itemId: 'item-1',
      role: 'user',
      type: 'text_delta',
      content: { type: 'text_delta', text: 'Finish the report' },
    })
    let loaded = 0
    const prompts: string[] = []
    const handle = {
      prompt: async (text: string) => {
        prompts.push(text)
      },
      cancel() {},
      kill() {},
    }
    const process: HarnessProcess = {
      capabilities: { loadSession: true },
      loadSession: async () => {
        loaded += 1
        throw new Error('provider session expired')
      },
      newSession: async () => ({ handle, proven: true }),
      spawn: async () => handle,
    }
    await recoverSessions(db, new SessionManager(db, bus, () => process), bus)
    expect(loaded).toBe(1)
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('Finish the report')
    expect(prompts[1]).toBe('The server restarted mid-turn. Continue.')
    expect(
      db
        .prepare(
          "SELECT count(*) AS count FROM messages WHERE session_id = ? AND type = 'error'",
        )
        .get(session.id),
    ).toEqual({ count: 1 })
  })

  it('does not resume an idle auto-resume chat on a later boot', async () => {
    const { db, project, bus } = setup()
    const session = createSession(db, {
      projectId: project.id,
      harness: 'fake',
      title: 'Chat',
      cwd: '/tmp',
    })
    db.prepare('UPDATE sessions SET auto_resume = 1 WHERE id = ?').run(
      session.id,
    )
    let starts = 0
    const handle = { prompt() {}, cancel() {}, kill() {} }
    const process: HarnessProcess = {
      capabilities: { loadSession: false },
      newSession: async () => {
        starts += 1
        return { handle, proven: true }
      },
      spawn: async () => handle,
    }
    await recoverSessions(db, new SessionManager(db, bus, () => process), bus)
    expect(starts).toBe(0)
  })
})
