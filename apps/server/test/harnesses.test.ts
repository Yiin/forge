import { NativeProcess } from '../src/harnesses/process.js'
import { closeAcpDiscovery } from '../src/harnesses/acp/discovery.js'
import { deferred } from '../src/harnesses/transport-test-helpers.js'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test, vi } from 'vitest'
import { createTestApp as createApp } from './app-fixture.js'
import { migrate } from '../src/db/migrate.js'
import { UploadStore } from '../src/uploads/store.js'
import { defaultConfig } from '../src/config.js'

describe('harness settings routes', () => {
  test('reports custom ACP as unverified and rejects a missing executable', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const store = new UploadStore(db, { dataDir: '/tmp/forge-harnesses-test' })
    const config = defaultConfig(true)
    const app = createApp(store, { db, bus: store.eventBus, version: 'test' })

    const listed = await app.request('/api/harnesses')
    expect(listed.status).toBe(200)
    expect(Object.keys(await listed.json())).toContain('mock')

    const good = await app.request('/api/harnesses/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'mock' }),
    })
    expect(good.status).toBe(200)
    expect(await good.json()).toMatchObject({
      ok: false,
      status: 'unverified',
      authentication: 'unknown',
    })

    config.harness.bad = {
      ...config.harness.mock!,
      command: 'definitely-not-a-real-binary-xyz',
      args: [],
    }
    // The test route owns its config instance in production. This request pins
    // the error contract through a persisted replacement in the same API.
    await app.request('/api/harnesses', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ harness: config.harness }),
    })
    const bad = await app.request('/api/harnesses/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'bad' }),
    })
    expect(bad.status).toBe(422)
    expect(await bad.json()).toMatchObject({ ok: false })
    const native = await app.request('/api/harnesses/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        harness: {
          ...config.harness.mock!,
          adapterKind: 'native',
          command: 'not-started-native',
        },
      }),
    })
    expect(await native.json()).toMatchObject({
      ok: false,
      status: 'unverified',
      authentication: 'unknown',
    })
    await store.close()
    db.close()
  }, 20_000)
})

test('runs only the dedicated Hermes availability check and joins its process cleanup', async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { harnessRoutes } = await import('../src/http/harnesses.js')
  const { AcpResourceHost } = await import('../src/harnesses/acp/limits.js')
  const directory = await mkdtemp(join(tmpdir(), 'forge-dedicated-probe-'))
  try {
    const command = join(directory, 'peer.mjs')
    const report = join(directory, 'argv.json')
    await writeFile(
      command,
      `#!${process.execPath}\nimport { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(report)}, JSON.stringify(process.argv.slice(2)));`,
      { mode: 0o700 },
    )
    const host = new AcpResourceHost()
    const config = defaultConfig(false)
    config.harness.hermes = { ...config.harness.hermes, command, enabled: true }
    const app = harnessRoutes({ config, host })
    const response = await app.request('/api/harnesses/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'hermes' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      status: 'available',
      authentication: 'unknown',
    })
    expect(JSON.parse(await readFile(report, 'utf8'))).toEqual([
      'acp',
      '--check',
    ])
    const release = host.reserve('hermes', 'processes', 8)
    release()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test.each(['held', 'refused'] as const)(
  'joins the original %s Test probe cleanup after its HTTP deadline',
  async (mode) => {
    const { mkdtemp, writeFile, readFile, rm } =
      await import('node:fs/promises')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { harnessRoutes } = await import('../src/http/harnesses.js')
    const { AcpResourceHost } = await import('../src/harnesses/acp/limits.js')
    const directory = await mkdtemp(join(tmpdir(), 'forge-probe-cleanup-'))
    const host = new AcpResourceHost()
    const held = deferred<void>(),
      entered = deferred<void>()
    const owners = new Set<NativeProcess>()
    let allowClose = false
    const originalClose = NativeProcess.prototype.close
    vi.spyOn(NativeProcess.prototype, 'close').mockImplementation(
      async function (this: NativeProcess, reason) {
        owners.add(this)
        await originalClose.call(this, reason)
        entered.resolve()
        if (mode === 'held') await held.promise
        else if (!allowClose) throw Error('Synthetic cleanup refused')
      },
    )
    const originalTimeout = globalThis.setTimeout
    let expire: (() => void) | undefined
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      if (ms === 15000 && !expire) {
        expire = () => callback(...args)
        return originalTimeout(() => {}, ms)
      }
      return originalTimeout(callback, ms, ...args)
    }) as typeof setTimeout)
    try {
      const report = join(directory, 'spawns')
      const command = join(directory, 'peer.mjs')
      await writeFile(
        command,
        `#!${process.execPath}\nimport { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(report)}, 'spawned\\n');`,
        { mode: 0o700 },
      )
      const config = defaultConfig(false)
      config.harness.hermes = {
        ...config.harness.hermes,
        command,
        enabled: true,
      }
      const app = harnessRoutes({ config, host })
      const request = () =>
        app.request('/api/harnesses/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'hermes' }),
        })
      const response = request()
      await entered.promise
      expect(expire).toBeDefined()
      expire!()
      expect((await response).status).toBe(422)
      let settled = false
      const close = closeAcpDiscovery(host).then(() => {
        settled = true
      })
      if (mode === 'held') {
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(settled).toBe(false)
        held.resolve()
        await close
      } else {
        await expect(close).rejects.toThrow()
        expect(settled).toBe(false)
        allowClose = true
        await closeAcpDiscovery(host)
      }
      expect(owners.size).toBe(1)
      expect([...owners][0]!.child.exitCode).toBe(0)
      expect((await request()).status).toBe(422)
      expect(await readFile(report, 'utf8')).toBe('spawned\n')
    } finally {
      allowClose = true
      held.resolve()
      try {
        await closeAcpDiscovery(host)
      } finally {
        vi.restoreAllMocks()
        await rm(directory, { recursive: true, force: true })
      }
    }
  },
)
