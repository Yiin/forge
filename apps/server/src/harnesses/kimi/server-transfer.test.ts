import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { KimiServer } from './server.js'
import { KimiBudget, kimiLimits } from './limits.js'

test('local HTTP occupancy refusal releases its JSON reservation before any IPC write', async () => {
  const budget = new KimiBudget(kimiLimits({ hostHttp: 1 })),
    release = budget.reserve('hostHttp')
  let writes = 0
  const server = Object.create(KimiServer.prototype) as KimiServer
  Object.assign(server, {
    hostBudget: budget,
    stopped: false,
    blobReleases: new Set(),
    transfers: new Set(),
    ipc: {
      send: async () => {
        writes++
      },
    },
    pending: new Map(),
    httpReleases: new Map(),
    ordinal: 0,
  })
  await expect(server.http('lane', '/api/v1/config')).rejects.toMatchObject({
    code: 'kimi_resource_limit',
  })
  expect(writes).toBe(0)
  expect(budget.count('hostHttpBufferBytes')).toBe(0)
  expect(budget.count('hostTimers')).toBe(0)
  expect(budget.count('hostHttp')).toBe(1)
  release()
})

test.each(['digest', 'length', 'base64', 'utf8', 'envelope'])(
  'refuses malformed owned %s transfer and releases its original blob',
  async (fault) => {
    const body =
      fault === 'utf8'
        ? Buffer.from([0xff])
        : Buffer.from(
            JSON.stringify({
              code: 0,
              msg: 'success',
              request_id: fault === 'envelope' ? 'other' : 'request',
              data: { ok: true },
            }),
          )
    const budget = new KimiBudget(kimiLimits()),
      released: string[] = []
    const server = Object.create(KimiServer.prototype) as KimiServer
    Object.assign(server, {
      hostBudget: budget,
      stopped: false,
      blobReleases: new Set(),
      transfers: new Set(),
      rpc: async (message: { op: string; blobId?: string }) => {
        if (message.op === 'http_wire')
          return {
            blobId: 'owned',
            sizeBytes: body.length + (fault === 'length' ? 1 : 0),
            sha256:
              fault === 'digest'
                ? '0'.repeat(64)
                : createHash('sha256').update(body).digest('hex'),
            requestId: 'request',
            status: 200,
          }
        if (message.op === 'blob_read')
          return {
            data: fault === 'base64' ? 'YQ===' : body.toString('base64'),
          }
        if (message.op === 'blob_release') {
          released.push(message.blobId!)
          return {}
        }
        throw new Error('Unexpected synthetic command')
      },
    })
    await expect(
      server.http('lane', '/api/v1/config', { maxBytes: 1024 }),
    ).rejects.toBeDefined()
    expect(released).toEqual(['owned'])
    expect(budget.count('hostHttpBufferBytes')).toBe(0)
    expect(budget.count('hostIpcBytes')).toBe(0)
    expect(budget.count('hostRetainedBytes')).toBe(0)
  },
)

test('initialize admission waits for the returned startup HTTP buffer', async () => {
  const limits = kimiLimits(),
    budget = new KimiBudget(limits),
    sent: Record<string, unknown>[] = []
  const server = Object.create(KimiServer.prototype) as KimiServer
  Object.assign(server, {
    hostBudget: budget,
    stopped: false,
    blobReleases: new Set(),
    transfers: new Set(),
    sockets: new Map(),
    pending: new Map(),
    httpReleases: new Map(),
    httpReleaseWaiters: new Map(),
    ordinal: 0,
    ipc: {
      send: async (value: Record<string, unknown>) => {
        sent.push(value)
      },
    },
  })
  const internals = server as unknown as {
    pending: Map<
      string,
      { resolve(value: unknown): void; release(): void; reject(): void }
    >
    httpReleases: Map<string, () => void>
    httpReleaseWaiters: Map<string, { resolve(): void }>
  }
  const startup = server.rpc({ op: 'initialize' }, 5000, false, true)
  let settled = false
  void startup.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  const startupReservation = 5 * limits.startupBytes
  expect(budget.count('hostHttpBufferBytes')).toBe(startupReservation)
  const id = sent[0].id as string
  const pending = internals.pending.get(id)!
  internals.pending.delete(id)
  pending.release()
  pending.resolve({ ok: true })
  await new Promise((resolve) => setImmediate(resolve))
  // The guardian answered, but its 'http_released' line has not arrived yet.
  expect(settled).toBe(false)
  expect(budget.count('hostHttpBufferBytes')).toBe(startupReservation)
  // Replay the parent's 'http_released' branch for this id.
  internals.httpReleases.get(id)!()
  internals.httpReleases.delete(id)
  internals.httpReleaseWaiters.get(id)!.resolve()
  internals.httpReleaseWaiters.delete(id)
  await expect(startup).resolves.toEqual({ ok: true })
  expect(budget.count('hostHttpBufferBytes')).toBe(0)
  expect(budget.count('hostHttp')).toBe(0)
  expect(budget.count('hostTimers')).toBe(0)
})
