import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'

const directory = process.argv[2]!
assert.ok(directory.startsWith('/var/tmp/forge-comet-terminal-implementation-'))
assert.equal(existsSync(directory), false)
mkdirSync(directory)
const home = join(directory, 'home'),
  accountsPath = join(directory, 'accounts')
mkdirSync(home)
mkdirSync(accountsPath)
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, {
  HOME: home,
  FORGE_ACCOUNTS_DIR: accountsPath,
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
})
const pty = createRequire(import.meta.url)('node-pty')
const originals: Array<{
  pid: number
  fd: number
  _socket: import('node:net').Socket & { closed: boolean }
  onExit(callback: () => void): unknown
}> = []
const spawn = pty.spawn
pty.spawn = (...args: unknown[]) => {
  const original = spawn(...args)
  originals.push(original)
  console.log(
    JSON.stringify({
      original: {
        pid: original.pid,
        fd: original.fd,
        stat: readFileSync(`/proc/${original.pid}/stat`, 'utf8'),
        command: args[0],
      },
    }),
  )
  return original
}
const { migrate } = await import('../src/db/migrate.js')
const { EventBus } = await import('../src/events/bus.js')
const { HarnessAccountStore } = await import('../src/accounts/store.js')
const { LoginManager } = await import('../src/accounts/login.js')
const { createPtyHarness } = await import('../src/pty/harness.js')
const db = new DatabaseSync(':memory:')
migrate(db)
const accounts = new HarnessAccountStore(db),
  bus = new EventBus()
const account = accounts.create({
  harnessKey: 'synthetic',
  label: 'Synthetic',
  kind: 'claude',
})
assert.ok(account.homePath.startsWith(accountsPath + '/'))
const script = join(directory, 'synthetic-login')
writeFileSync(
  script,
  '#!/bin/sh\nread value\nprintf "SYNTHETIC_LOGIN:%s\\n" "$value"\nexit 0\n',
  { mode: 0o700 },
)
const login = new LoginManager(
  accounts,
  bus,
  () => ({
    name: 'Synthetic',
    command: script,
    args: [],
    env: {},
    protocol: 'pty',
    enabled: true,
  }),
  () => script,
)
async function until(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Synthetic caller did not reach ${label}`)
}
try {
  const id = login.start(account.id)
  await until(() => login.get(id)?.status === 'running', 'ordinary login input')
  login.respond(id, 'owned-fixture')
  await until(
    () => login.get(id)?.status === 'succeeded',
    'ordinary login exit',
  )
  assert.ok(login.get(id)!.output.includes('SYNTHETIC_LOGIN:owned-fixture'))
  const items: Array<{ type: string; text?: string }> = []
  let exited = false
  const harness = createPtyHarness({
    command: '/bin/sh',
    args: [
      '-c',
      'read value; printf "SYNTHETIC_HARNESS:%s\\n" "$value"; exit 0',
    ],
    env: { HOME: home },
    maxTurnMs: 1000,
    quietPeriodMs: 20,
  })
  const handle = await harness.spawn(
    { id: 'synthetic-session', harness: 'synthetic', cwd: directory },
    (item) => items.push(item),
    () => {
      exited = true
    },
  )
  await handle.prompt('owned-fixture')
  await until(() => exited, 'ordinary harness exit')
  const text = items
    .filter((item) => item.type === 'text_delta')
    .map((item) => item.text)
    .join('')
  assert.ok(text.includes('SYNTHETIC_HARNESS:owned-fixture'), text)
  assert.equal(originals.length, 2)
  console.log(
    JSON.stringify({
      passed: {
        actualLoginManager: true,
        actualPtyHarness: true,
        ordinaryNativeSpawns: originals.length,
      },
      items,
    }),
  )
} finally {
  for (const original of originals) {
    if (!original._socket.closed) {
      const closed = once(original._socket, 'close')
      original._socket.destroy()
      await closed
    }
    await until(
      () => !existsSync(`/proc/${original.pid}`),
      'original ordinary child reap',
    )
    console.log(
      JSON.stringify({
        cleanup: {
          pid: original.pid,
          socketClosed: original._socket.closed,
          pidAbsent: true,
        },
      }),
    )
  }
  login.close()
  db.close()
}
