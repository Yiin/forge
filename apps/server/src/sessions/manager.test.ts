import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.js'
import { createProject, createSession } from '../db/queries.js'
import { EventBus } from '../events/bus.js'
import { SessionManager } from './manager.js'
import type { HarnessFactory, HarnessHandle } from './harness.js'

describe('session harness selection', () => {
  it('rejects a harness without a managed account', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'test', path: '/tmp' })
    const manager = new SessionManager(db, new EventBus(), () => ({
      spawn: async () => {
        throw new Error('should not spawn')
      },
    }))

    expect(() =>
      manager.create({ projectId: project.id, harness: 'claude', cwd: '/tmp' }),
    ).toThrow('This harness has no account')
  })

  it('records a usage limit from a failed prompt', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'test', path: '/tmp' })
    db.prepare(
      "INSERT INTO harness_accounts (id, harness_key, label, kind, home_path, created_at) VALUES ('acct', 'claude', 'Test', 'claude', '/tmp/acct', 1)",
    ).run()
    const session = createSession(db, {
      projectId: project.id,
      harness: 'claude',
      title: 'Chat',
      cwd: '/tmp',
      accountId: 'acct',
    })
    const factory: HarnessFactory = () => ({
      spawn: async () => ({
        prompt: async () => {
          throw new Error('Claude AI usage limit reached')
        },
        cancel: () => undefined,
        kill: () => undefined,
      }),
    })
    const manager = new SessionManager(db, new EventBus(), factory)
    await expect(manager.prompt(session.id, 'one')).rejects.toThrow(
      'usage limit',
    )
    expect(
      db.prepare('SELECT account_id, kind FROM harness_account_limits').get(),
    ).toMatchObject({ account_id: 'acct', kind: 'usage-limit' })
  })

  it('uses the selected harness and persists it before the prompt', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const project = createProject(db, { name: 'test', path: '/tmp' })
    db.prepare(
      "INSERT INTO harness_accounts (id, harness_key, label, kind, home_path, created_at) VALUES ('first-account', 'first', 'First', 'claude', '/tmp/first', 1), ('second-account', 'second', 'Second', 'claude', '/tmp/second', 1)",
    ).run()
    const session = createSession(db, {
      projectId: project.id,
      harness: 'first',
      accountId: 'first-account',
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
    await manager.prompt(
      session.id,
      'two',
      undefined,
      undefined,
      'second',
      'second-account',
    )

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
