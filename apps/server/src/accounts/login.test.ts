import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { migrate } from '../db/migrate.js'
import { EventBus } from '../events/bus.js'
import { HarnessAccountStore } from './store.js'
import { LoginManager } from './login.js'

const resources: Array<{ db: DatabaseSync; root: string; script: string }> = []
afterEach(() => {
  vi.useRealTimers()
  for (const resource of resources.splice(0)) {
    resource.db.close()
    rmSync(resource.root, { recursive: true, force: true })
  }
})

function fixture(body: string) {
  const db = new DatabaseSync(':memory:')
  const root = mkdtempSync(join(tmpdir(), 'forge-login-'))
  const script = join(root, 'login.sh')
  writeFileSync(script, `#!/bin/sh\n${body}\n`)
  chmodSync(script, 0o700)
  migrate(db)
  const accounts = new HarnessAccountStore(db)
  const account = accounts.create({
    harnessKey: 'claude',
    label: 'Test',
    kind: 'claude',
  })
  const bus = new EventBus()
  const events: unknown[] = []
  bus.subscribeEphemeral((event) => events.push(event))
  const login = new LoginManager(accounts, bus, () => ({
    command: script,
    args: [],
    env: {},
    protocol: 'pty',
    name: 'test',
    enabled: true,
  }))
  resources.push({ db, root, script })
  return { login, account, events }
}
async function waitFor(login: LoginManager, id: string, status: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (login.get(id)?.status === status) return login.get(id)!
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`login did not reach ${status}`)
}

describe('LoginManager', () => {
  it('publishes idle, running, and succeeded with clean bounded output and extracted values', async () => {
    const { login, account, events } = fixture(
      'printf "\\033[31mhttps://example.test/device\\033[0m code: AB12-XY\\n"',
    )
    const id = login.start(account.id)
    const state = await waitFor(login, id, 'succeeded')
    expect(state.output).toContain('https://example.test/device')
    expect(state.output).not.toContain('\u001b')
    expect(state.verificationUrl).toBe('https://example.test/device')
    expect(state.userCode).toBe('AB12-XY')
    const statuses = events.map(
      (event) => (event as { state: { status: string } }).state.status,
    )
    expect(statuses[0]).toBe('idle')
    expect(statuses).toContain('running')
    expect(statuses.at(-1)).toBe('succeeded')
  })

  it('reports non-zero exits and forwards responses without persistence', async () => {
    const { login, account } = fixture(
      'read answer\nprintf "received:%s\\n" "$answer"\nexit 7',
    )
    const id = login.start(account.id)
    await waitFor(login, id, 'running')
    login.respond(id, 'secret-value')
    const state = await waitFor(login, id, 'failed')
    expect(state.message).toContain('code 7')
    expect(state.output).toContain('received:secret-value')
  })

  it('keeps only the last 10,000 output characters', async () => {
    const { login, account } = fixture('printf "%*s\\n" 11000 x')
    const id = login.start(account.id)
    const state = await waitFor(login, id, 'succeeded')
    expect(state.output.length).toBeLessThanOrEqual(10_000)
  })

  it('cancels a running PTY and fails silent runs after ten minutes', async () => {
    const first = fixture('sleep 30')
    const id = first.login.start(first.account.id)
    await waitFor(first.login, id, 'running')
    first.login.cancel(id)
    expect(first.login.get(id)?.status).toBe('cancelled')

    vi.useFakeTimers()
    const second = fixture('sleep 30')
    const timeoutId = second.login.start(second.account.id)
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(second.login.get(timeoutId)?.status).toBe('failed')
  })
})
