import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createApp, createEpicSessionAdapter } from '../src/index.js'
import { migrate } from '../src/db/migrate.js'
import { createProject, createRun } from '../src/db/queries.js'
import { EventBus } from '../src/events/bus.js'
import { EpicRunner } from '../src/epics/runner.js'
import { SessionManager } from '../src/sessions/manager.js'
import { UploadStore } from '../src/uploads/store.js'

describe('epic production wiring', () => {
  it('mounts epic routes and persists runs through the app wiring', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const bus = new EventBus()
    const store = new UploadStore(db, {
      dataDir: '/tmp/forge-epic-wiring',
      bus,
    })
    const project = createProject(db, { name: 'Forge', path: '/tmp' })
    const manager = new SessionManager(db, bus, () => ({
      spawn: async () => ({
        prompt: async () => {},
        cancel: async () => {},
        kill: async () => {},
      }),
    }))
    const runner = new EpicRunner(db, createEpicSessionAdapter(manager), bus)
    const app = createApp(
      store,
      { db, bus, version: 'test', dataDir: '/tmp/forge-epic-wiring' },
      undefined,
      manager,
      runner,
    )

    const list = await app.request('/api/epics')
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual([])

    const response = await app.request('/api/epics/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        epicBeadId: 'forge-test',
        repoPath: '/tmp',
        mode: 'serial',
        workerCount: 1,
        baseBranch: 'main',
        config: {},
      }),
    })
    expect(response.status).toBe(202)
    expect(db.prepare('SELECT count(*) AS count FROM epic_runs').get()).toEqual(
      {
        count: 1,
      },
    )
    manager.close()
  })

  it('creates and cancels an epic worker session with its run link', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const bus = new EventBus()
    let cancelled = 0
    const manager = new SessionManager(db, bus, () => ({
      spawn: async () => ({
        prompt: async () => {},
        cancel: async () => {
          cancelled += 1
        },
        kill: async () => {},
      }),
    }))
    const project = createProject(db, { name: 'Forge', path: '/tmp' })
    db.prepare(
      "INSERT INTO harness_accounts (id, harness_key, label, kind, home_path, created_at) VALUES ('acct', 'default', 'Default', 'claude', '/tmp/acct', 1)",
    ).run()
    const run = createRun(db, {
      projectId: project.id,
      epicBeadId: 'forge-test',
      status: 'running',
      mode: 'serial',
      workerCount: 1,
      baseBranch: 'main',
      config: {},
      originSessionId: null,
    })
    const session = await createEpicSessionAdapter(manager).create({
      projectId: project.id,
      harness: 'default',
      cwd: '/tmp',
      title: 'worker',
      kind: 'epic_worker',
      epicRunId: run.id,
      accountId: 'acct',
    })
    const row = db
      .prepare('SELECT kind, epic_run_id, retention FROM sessions WHERE id = ?')
      .get(session.id)
    expect(row).toEqual({
      kind: 'epic_worker',
      epic_run_id: run.id,
      retention: 'permanent',
    })

    await session.prompt('work')
    await session.cancel()
    expect(cancelled).toBeGreaterThan(0)
    expect(
      db
        .prepare('SELECT retention, status FROM sessions WHERE id = ?')
        .get(session.id),
    ).toEqual({ retention: 'discardable', status: 'archived' })
    manager.close()
  })
})
