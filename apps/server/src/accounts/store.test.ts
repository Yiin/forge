import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.js'
import {
  createIteration,
  createProject,
  createRun,
  createSession,
} from '../db/queries.js'
import { harnessAccountRoutes } from '../http/harnessAccounts.js'
import { HarnessAccountStore, accountEnv } from './store.js'

const resources: Array<{ db: DatabaseSync; root: string }> = []
afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.db.close()
    rmSync(resource.root, { recursive: true, force: true })
  }
  delete process.env.FORGE_ACCOUNTS_DIR
})

function fixture() {
  const db = new DatabaseSync(':memory:')
  const root = mkdtempSync(join(tmpdir(), 'forge-accounts-'))
  process.env.FORGE_ACCOUNTS_DIR = root
  migrate(db)
  resources.push({ db, root })
  return { db, root }
}

describe('HarnessAccountStore', () => {
  it('creates private homes and preserves them when deleting by default', () => {
    const { db, root } = fixture()
    const store = new HarnessAccountStore(db)
    const account = store.create({
      harnessKey: 'claude',
      label: 'Personal',
      kind: 'claude',
    })
    expect(statSync(account.homePath).mode & 0o777).toBe(0o700)
    expect(account.homePath).toBe(join(root, 'claude', account.id))
    expect(store.delete(account.id)).toBe(true)
    expect(statSync(account.homePath).isDirectory()).toBe(true)
  })

  it('maps each supported harness to its isolation environment', () => {
    const home = '/tmp/account'
    expect(accountEnv('claude', home)).toEqual({ CLAUDE_CONFIG_DIR: home })
    expect(accountEnv('codex', home)).toEqual({ CODEX_HOME: home })
    expect(accountEnv('kimi', home)).toEqual({ KIMI_SHARE_DIR: home })
    expect(accountEnv('opencode', home)).toEqual({
      XDG_DATA_HOME: home,
      OPENCODE_DB: '/tmp/account/opencode/opencode.db',
    })
    expect(accountEnv('unknown', home)).toEqual({})
  })

  it('persists account ids on sessions and epic iterations', () => {
    const { db } = fixture()
    const project = createProject(db, { name: 'Forge', path: '/tmp/forge' })
    const session = createSession(db, {
      projectId: project.id,
      harness: 'claude',
      title: 'Chat',
      cwd: '/tmp',
      accountId: 'acct_test',
    })
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
    const iteration = createIteration(db, {
      runId: run.id,
      beadId: 'forge-test.1',
      sessionId: session.id,
      worktreePath: '/tmp/worktree',
      branch: 'test',
      accountId: 'acct_test',
    })
    expect(
      (
        db
          .prepare('SELECT account_id FROM sessions WHERE id = ?')
          .get(session.id) as any
      ).account_id,
    ).toBe('acct_test')
    expect(
      (
        db
          .prepare('SELECT account_id FROM epic_iterations WHERE id = ?')
          .get(iteration.id) as any
      ).account_id,
    ).toBe('acct_test')
  })

  it('supports create, list, rename, reorder, and delete routes', async () => {
    const { db } = fixture()
    const app = harnessAccountRoutes(db)
    const create = await app.request('/api/harness-accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        harnessKey: 'codex',
        label: 'Work',
        kind: 'codex',
      }),
    })
    expect(create.status).toBe(201)
    const account = await create.json()
    const id = (account as { id: string }).id
    expect((await app.request('/api/harness-accounts')).status).toBe(200)
    const patch = await app.request(`/api/harness-accounts/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Office', orderIndex: 3 }),
    })
    expect(await patch.json()).toMatchObject({ label: 'Office', orderIndex: 3 })
    const homePath = (account as { homePath: string }).homePath
    expect(
      (await app.request(`/api/harness-accounts/${id}`, { method: 'DELETE' }))
        .status,
    ).toBe(200)
    expect(statSync(homePath).isDirectory()).toBe(true)
  })

  it('replays migrations cleanly', () => {
    const { db } = fixture()
    migrate(db)
    expect(
      (
        db
          .prepare(
            "SELECT name FROM schema_migrations WHERE name = '0010_harness_accounts.sql'",
          )
          .get() as any
      ).name,
    ).toBe('0010_harness_accounts.sql')
  })
})
