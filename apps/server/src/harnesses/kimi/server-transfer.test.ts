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
