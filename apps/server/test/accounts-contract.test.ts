import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/index.js'
import { migrate } from '../src/db/migrate.js'
import { UploadStore } from '../src/uploads/store.js'
import { SessionManager } from '../src/sessions/manager.js'
import { AccountsApi } from '../../web/src/lib/accounts-api.js'

// Regression guard for forge-oge: the web accounts client must speak the
// server's real contract, not an invented one. This drives the actual web
// AccountsApi class against the actual server app (in-memory DB, real
// routes) instead of a mock, so a route-name or shape drift fails here.

const resources: string[] = []
afterEach(() => {
  for (const root of resources.splice(0))
    rmSync(root, { recursive: true, force: true })
  delete process.env.FORGE_ACCOUNTS_DIR
})

function fixture() {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const root = mkdtempSync(join(tmpdir(), 'forge-accounts-contract-'))
  process.env.FORGE_ACCOUNTS_DIR = root
  resources.push(root)
  const store = new UploadStore(db, { dataDir: root })
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
      },
      settings: {
        titleGeneration: true,
        keybindings: {},
        epicDefaults: { workerCount: 3, mode: 'pool' as const },
      },
    },
  }
  const manager = new SessionManager(db, store.eventBus, () => ({
    spawn: () => ({ prompt() {}, cancel() {}, kill() {} }),
  }))
  const app = createApp(
    store,
    { db, bus: store.eventBus, version: 'test' },
    undefined,
    manager,
    undefined,
    undefined,
    configState,
  )
  const api = new AccountsApi({
    baseUrl: '',
    fetch: app.request.bind(app) as unknown as typeof fetch,
  })
  return { api }
}

describe('web AccountsApi against the real server routes', () => {
  it('drives the account lifecycle end to end', async () => {
    const { api } = fixture()

    expect(await api.listHarnessStatus()).toEqual([])

    const first = await api.createAccount({
      harnessKey: 'claude',
      label: 'Work',
      kind: 'claude',
    })
    const second = await api.createAccount({
      harnessKey: 'claude',
      label: 'Personal',
      kind: 'claude',
    })
    expect(first.harnessKey).toBe('claude')

    const accounts = await api.listAccounts()
    expect(accounts.map((account) => account.id).sort()).toEqual(
      [first.id, second.id].sort(),
    )
    expect(
      accounts.every((account) => account.authStatus === 'unauthenticated'),
    ).toBe(true)

    const status = await api.listHarnessStatus()
    expect(status).toHaveLength(2)
    expect(status.every((entry) => entry.harnessKind === 'claude')).toBe(true)
    expect(status.every((entry) => entry.harnessKey === 'claude')).toBe(true)
    expect(
      accounts.every(
        (account) =>
          account.kind === 'claude' && account.harnessKey === 'claude',
      ),
    ).toBe(true)

    const patched = await api.updateAccount(first.id, { label: 'Renamed' })
    expect(patched.label).toBe('Renamed')

    const configured = await api.updateAccount(first.id, {
      config: { provider: 'ignored', model: 'ignored', thinking: 'high' },
    })
    expect(configured.config).toEqual({
      provider: 'ignored',
      model: 'ignored',
      thinking: 'high',
    })
    expect(
      (await api.updateAccount(first.id, { label: 'Still configured' })).config,
    ).toEqual(configured.config)

    await api.reorderAccounts([second.id, first.id])
    const reordered = await api.listAccounts()
    expect(reordered.map((account) => account.id)).toEqual([
      second.id,
      first.id,
    ])

    expect(await api.clearCooldown(first.id)).toEqual({ ok: true })

    const loggedOut = await api.logout({ accountId: first.id })
    expect(loggedOut.authenticated).toBe(false)

    expect(await api.deleteAccount(second.id, true)).toEqual({ ok: true })
    expect(existsSync(second.homePath)).toBe(false)
    expect((await api.listAccounts()).map((account) => account.id)).toEqual([
      first.id,
    ])

    expect(await api.getAccountsDir()).toBe(process.env.FORGE_ACCOUNTS_DIR)
  })
})
