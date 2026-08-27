import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrate } from '../src/db/migrate.js'
import { EventBus } from '../src/events/bus.js'
import {
  createHarnessHealthReader,
  harnessHealthRoutes,
} from '../src/http/harnessHealth.js'
import { statusRoutes } from '../src/http/status.js'
import { SessionManager } from '../src/sessions/manager.js'
import { createProject, createSession } from '../src/db/queries.js'
import { StatusResponse } from '@forge/protocol/status'

function setup() {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const root = mkdtempSync(join(tmpdir(), 'forge-health-'))
  const homes = {
    claude: join(root, 'claude'),
    codex: join(root, 'codex'),
  }
  for (const [key, home] of Object.entries(homes)) {
    mkdirSync(home, { recursive: true })
    db.prepare(
      `INSERT INTO harness_accounts (id, harness_key, label, kind, home_path, order_index, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(key, key, 'Account', key, home, 0, 1)
  }
  const configState = {
    current: {
      dataDir: root,
      port: 3900,
      harness: {
        claude: {
          name: 'Claude',
          command: 'claude',
          args: [],
          env: {},
          protocol: 'acp' as const,
          enabled: true,
        },
        codex: {
          name: 'Codex',
          command: 'codex',
          args: [],
          env: {},
          protocol: 'pty' as const,
          enabled: true,
        },
      },
      settings: {
        titleGeneration: true,
        keybindings: {},
        epicDefaults: { workerCount: 3, mode: 'pool' as const },
      },
    },
  }
  return { db, root, homes, configState }
}

describe('harness health', () => {
  it('reports configured harnesses, authentication, and live cooldowns', async () => {
    const { db, homes, configState } = setup()
    writeFileSync(join(homes.claude, '.credentials.json'), '{}')
    db.prepare(
      `INSERT INTO harness_account_limits
      (account_id, kind, harness_key, detected_at, resets_at, resets_at_estimated, source, detail)
      VALUES ('claude', 'usage-limit', 'claude', 100, 2000000000000, 1, 'test', 'wait')`,
    ).run()
    db.prepare(
      `INSERT INTO harness_account_limits
      (account_id, kind, harness_key, detected_at, resets_at, resets_at_estimated, source, detail)
      VALUES ('codex', 'rate-limit', 'codex', 100, 1, 0, 'test', 'old')`,
    ).run()
    const manager = new SessionManager(db, new EventBus(), () => ({
      spawn: () => ({ prompt() {}, cancel() {}, kill() {} }),
    }))
    const app = harnessHealthRoutes({ db, configState, manager })
    const response = await app.request('/api/harnesses/health')
    const body = await response.json()
    expect(body).toHaveLength(2)
    expect(body[0].accounts[0]).toMatchObject({
      authenticated: true,
      cooldown: { kind: 'usage-limit' },
    })
    expect(body[1].accounts[0]).toMatchObject({
      authenticated: false,
      cooldown: null,
    })
    expect(
      db
        .prepare(
          "SELECT account_id FROM harness_account_limits WHERE account_id = 'codex'",
        )
        .all(),
    ).toEqual([])
  })

  it('feeds dynamic process counts into status', async () => {
    const { db, configState } = setup()
    const bus = new EventBus()
    const manager = new SessionManager(db, bus, () => ({
      spawn: async () => ({
        prompt: async () => {},
        cancel: () => {},
        kill: () => {},
      }),
    }))
    const project = createProject(db, { name: 'test', path: '/tmp' })
    const session = createSession(db, {
      projectId: project.id,
      harness: 'claude',
      title: 'Chat',
      cwd: '/tmp',
    })
    await manager.prompt(session.id, 'hello')
    const health = createHarnessHealthReader({ db, configState, manager })
    const app = statusRoutes({ db, bus, version: 'dev', harnesses: health })
    const status = StatusResponse.parse(
      await (await app.request('/api/status')).json(),
    )
    expect(
      status.harnesses.find((h) => h.key === 'claude')?.liveProcesses,
    ).toBe(1)
  })
})
