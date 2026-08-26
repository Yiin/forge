import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.js'
import { createProject, createSession } from '../db/queries.js'
import { EventBus } from '../events/bus.js'
import { SessionManager } from './manager.js'
import type { HarnessFactory, HarnessHandle } from './harness.js'

describe('session harness selection', () => {
  it('uses the selected harness and persists it before the prompt', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'test', path: '/tmp' })
    const session = createSession(db, {
      projectId: project.id,
      harness: 'first',
      title: 'Chat',
      cwd: '/tmp',
    })
    const spawned: string[] = []
    let killed = 0
    const handle = (): HarnessHandle => ({
      prompt: async () => undefined,
      cancel: () => undefined,
      kill: () => {
        killed += 1
      },
    })
    const factory: HarnessFactory = (harness) => ({
      spawn: async () => {
        spawned.push(harness)
        return handle()
      },
    })
    const manager = new SessionManager(db, new EventBus(), factory)

    await manager.prompt(session.id, 'one', undefined, undefined, 'first')
    await manager.prompt(session.id, 'two', undefined, undefined, 'second')

    expect(spawned).toEqual(['first', 'second'])
    expect(killed).toBe(1)
    expect(
      (
        db
          .prepare('SELECT harness FROM sessions WHERE id = ?')
          .get(session.id) as { harness: string }
      ).harness,
    ).toBe('second')
  })
})
