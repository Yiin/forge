import { DatabaseSync } from 'node:sqlite'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
import {
  HarnessAccountStore,
  accountConfigOverlay,
  accountEnv,
  deriveAccountHarness,
  accountKindForHarness,
} from './store.js'

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
    expect(accountEnv('grok', home)).toEqual({ GROK_HOME: home })
    expect(accountEnv('pi', home)).toEqual({
      PI_CODING_AGENT_DIR: home,
      PI_CODING_AGENT_SESSION_DIR: '/tmp/account/sessions',
    })
    expect(accountEnv('unknown', home)).toEqual({})
  })

  it('derives per-account provider and effort settings without changing isolation', () => {
    const home = '/tmp/account'
    expect(
      deriveAccountHarness(
        {
          name: 'Grok',
          command: 'grok',
          args: ['agent', 'stdio'],
          env: { BASE: '1' },
          protocol: 'acp',
          enabled: true,
        },
        {
          kind: 'grok',
          homePath: home,
          config: { model: 'grok-4.6', thinking: 'high' },
        },
      ),
    ).toMatchObject({
      args: ['agent', '--model', 'grok-4.6', '--effort', 'high', 'stdio'],
      env: { BASE: '1', GROK_HOME: home },
    })
    const opencode = accountConfigOverlay('opencode', home, {
      provider: 'anthropic',
      model: 'claude-sonnet',
      thinking: 'medium',
    })
    expect(JSON.parse(opencode.env.OPENCODE_CONFIG_CONTENT)).toEqual({
      model: 'anthropic/claude-sonnet',
      provider: {
        anthropic: {
          models: {
            'claude-sonnet': { options: { reasoningEffort: 'medium' } },
          },
        },
      },
    })
    expect(
      deriveAccountHarness(
        {
          name: 'Claude',
          command: 'claude',
          args: ['stdio'],
          env: { CLAUDE_CONFIG_DIR: '/wrong' },
          protocol: 'acp',
          enabled: true,
        },
        {
          kind: 'claude',
          homePath: home,
          config: { provider: 'ignored', model: 'ignored' },
        },
      ).env.CLAUDE_CONFIG_DIR,
    ).toBe(home)
  })

  it('preserves unrelated pi settings while applying account defaults', () => {
    const { db } = fixture()
    const store = new HarnessAccountStore(db)
    const account = store.create({
      harnessKey: 'pi',
      label: 'Pi',
      kind: 'pi',
      config: { provider: 'llama-cpp', model: 'gemma', thinking: 'medium' },
    })
    writeFileSync(
      join(account.homePath, 'settings.json'),
      JSON.stringify({ quietStartup: true }),
    )
    const derived = deriveAccountHarness(
      {
        name: 'Pi',
        command: 'pi-acp',
        args: ['stdio'],
        env: {},
        protocol: 'acp',
        enabled: true,
      },
      account,
    )
    expect(derived.args).toEqual([
      '--provider',
      'llama-cpp',
      '--model',
      'gemma',
      '--thinking',
      'medium',
      'stdio',
    ])
    expect(
      JSON.parse(readFileSync(join(account.homePath, 'settings.json'), 'utf8')),
    ).toEqual({
      quietStartup: true,
      defaultProvider: 'llama-cpp',
      defaultModel: 'gemma',
      defaultThinkingLevel: 'medium',
    })
  })

  it('keeps empty and ignored configs unchanged', () => {
    const home = '/tmp/account'
    const entry = {
      name: 'Claude',
      command: 'claude',
      args: ['stdio'],
      env: {},
      protocol: 'acp' as const,
      enabled: true,
    }
    expect(
      deriveAccountHarness(entry, {
        kind: 'claude',
        homePath: home,
        config: null,
      }),
    ).toEqual({
      ...entry,
      env: { CLAUDE_CONFIG_DIR: home },
    })
    expect(
      accountConfigOverlay('codex', home, { provider: 'ignored' }),
    ).toEqual({ env: {}, args: [] })
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

  it('persists identity and keeps it when a patch omits identity', async () => {
    const { db } = fixture()
    const store = new HarnessAccountStore(db)
    const account = store.create({
      harnessKey: 'claude',
      label: 'Work',
      kind: 'claude',
    })
    store.saveIdentity(account.id, {
      status: 'authenticated',
      email: 'person@example.com',
      plan: 'max',
    })
    const app = harnessAccountRoutes(db)
    const response = await app.request(`/api/harness-accounts/${account.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Office' }),
    })
    expect(await response.json()).toMatchObject({
      label: 'Office',
      identity: { email: 'person@example.com' },
    })
    const rejected = await app.request(`/api/harness-accounts/${account.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identity: { status: 'unknown', extra: true } }),
    })
    expect(rejected.status).toBe(400)
  })

  it('clears credentials on logout, and optionally wipes the whole home', async () => {
    const { db } = fixture()
    const app = harnessAccountRoutes(db)
    const store = new HarnessAccountStore(db)
    const account = store.create({
      harnessKey: 'claude',
      label: 'Work',
      kind: 'claude',
    })
    writeFileSync(join(account.homePath, '.credentials.json'), '{}')

    const loggedOut = await app.request(
      `/api/harness-accounts/${account.id}/logout`,
      { method: 'POST' },
    )
    expect(await loggedOut.json()).toEqual({ authenticated: false })
    expect(existsSync(join(account.homePath, '.credentials.json'))).toBe(false)
    expect(statSync(account.homePath).isDirectory()).toBe(true)

    writeFileSync(join(account.homePath, 'extra.txt'), 'keep-me')
    const wiped = await app.request(
      `/api/harness-accounts/${account.id}/logout`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deleteAccountHome: true }),
      },
    )
    expect(wiped.status).toBe(200)
    expect(existsSync(join(account.homePath, 'extra.txt'))).toBe(false)
    expect(statSync(account.homePath).isDirectory()).toBe(true)

    expect(
      (
        await app.request('/api/harness-accounts/missing/logout', {
          method: 'POST',
        })
      ).status,
    ).toBe(404)
  })

  it('clears recorded cooldowns for an account', async () => {
    const { db } = fixture()
    const app = harnessAccountRoutes(db)
    const store = new HarnessAccountStore(db)
    const account = store.create({
      harnessKey: 'claude',
      label: 'Work',
      kind: 'claude',
    })
    db.prepare(
      `INSERT INTO harness_account_limits
        (account_id, kind, harness_key, detected_at, resets_at, resets_at_estimated, source, detail)
       VALUES (?, 'usage-limit', 'claude', ?, NULL, 0, 'test', NULL)`,
    ).run(account.id, Date.now())

    const cleared = await app.request(
      `/api/harness-accounts/${account.id}/clear-cooldown`,
      { method: 'POST' },
    )
    expect(await cleared.json()).toEqual({ ok: true })
    expect(
      db
        .prepare('SELECT * FROM harness_account_limits WHERE account_id = ?')
        .all(account.id),
    ).toEqual([])

    expect(
      (
        await app.request('/api/harness-accounts/missing/clear-cooldown', {
          method: 'POST',
        })
      ).status,
    ).toBe(404)
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

describe('accountKindForHarness', () => {
  it('maps default harness entries to their account kinds', () => {
    expect(
      accountKindForHarness('claude-code-acp', {
        command: 'npx',
        args: ['@zed-industries/claude-code-acp'],
      }),
    ).toBe('claude')
    expect(accountKindForHarness('grok', { command: 'grok' })).toBe('grok')
    expect(accountKindForHarness('pi', { command: 'pi' })).toBe('pi')
  })
  it('returns null for kind-less harnesses', () => {
    expect(accountKindForHarness('gemini', { command: 'gemini' })).toBeNull()
    expect(
      accountKindForHarness('mock', {
        command: 'bun',
        args: ['apps/server/test/fixtures/acp-mock-agent.ts'],
      }),
    ).toBeNull()
  })
  it('does not substring-match pi inside other words', () => {
    expect(
      accountKindForHarness('pipeline', { command: 'pipeline-tool' }),
    ).toBeNull()
  })
})
