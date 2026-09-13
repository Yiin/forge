import { expect, test, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { directoryIdentity, type EffectiveAuthority } from './authority.js'
import { KimiHostOwner, type KimiLease } from './host.js'
import { KimiBudget } from './limits.js'
import { KimiRuntime } from './runtime.js'
import { KimiServer } from './server.js'
import { prepareInput } from './input.js'
import type { HarnessSession } from '../types.js'
import type { KimiAdapterOptions } from './types.js'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const scope = {
  provider: 'kimi',
  accountId: 'synthetic',
  cwd: '/inert',
  providerSessionId: 'native',
}
const catalog = {
  version: '0.34.0',
  models: [],
  commands: { status: 'unsupported', reason: 'synthetic' },
}

test.each(['local', 'host'] as const)(
  'failed runtime construction rolls back %s retained admission on the same host',
  async (kind) => {
    const host = new KimiHostOwner()
    const done = deferred()
    const server = { done: done.promise, cleanupProved: false }
    const make = (budget: KimiBudget) =>
      Reflect.construct(KimiRuntime, [
        {
          id: 'v2-constructor',
          cwd: '/inert',
          provider: 'kimi',
          accountId: 'synthetic',
        },
        { selected: { account: { config: {} } }, environment: {} },
        host,
        { server },
        scope,
        catalog,
        {
          commitRecords: async () => {
            throw new Error('No sink expected')
          },
        },
        () => {},
        budget,
      ]) as KimiRuntime
    let releaseOther = () => {}
    try {
      if (kind === 'host')
        releaseOther = host.budget.reserve(
          'hostRetainedBytes',
          host.budget.limits.hostRetainedBytes - 1024,
        )
      const before = host.budget.count('hostRetainedBytes')
      for (let i = 0; i < 5; i++) {
        const budget = new KimiBudget({
          ...host.budget.limits,
          ...(kind === 'local' ? { retainedBytes: 1024 } : {}),
        })
        let failure: unknown
        try {
          make(budget)
        } catch (error) {
          failure = error
        }
        expect(failure).toMatchObject({ code: 'kimi_resource_limit' })
        expect(budget.count('retainedBytes')).toBe(0)
        expect(host.budget.count('hostRetainedBytes')).toBe(before)
      }
      releaseOther()
      const validBudget = new KimiBudget(host.budget.limits)
      const runtime = make(validBudget)
      expect(runtime.binding).toEqual(scope)
      expect(host.budget.count('hostRetainedBytes')).toBeGreaterThan(0)
      server.cleanupProved = true
      done.resolve()
      await tick()
      expect(validBudget.count('retainedBytes')).toBe(0)
      expect(host.budget.count('hostRetainedBytes')).toBe(0)
    } finally {
      releaseOther()
      server.cleanupProved = true
      done.resolve()
      await tick()
      await host.close()
    }
  },
)

test('public create rolls back repeated constructor refusals and admits a later runtime on the same host', async () => {
  const path = await mkdtemp(
    '/var/tmp/forge-comet-kimi-review-correction-v2-constructor-',
  )
  const host = new KimiHostOwner({
    limits: {
      modelCatalogBytes: 512,
      retainedBytes: 2 * 1048576 + 4 * 131072 + 2048,
    },
  })
  const identity = await directoryIdentity(path)
  const authority = {
    selected: { provider: 'kimi', account: { id: 'synthetic', config: {} } },
    environment: {},
    home: identity,
    executable: identity,
    bootstrapCwd: path,
  } as unknown as EffectiveAuthority
  const session = {
    id: 'v2-public-constructor',
    provider: 'kimi',
    accountId: 'synthetic',
    cwd: path,
  }
  let nativeCreates = 0,
    serverCloses = 0,
    initialized = 0
  const start = vi.spyOn(KimiServer, 'start').mockImplementation(async () => {
    const done = deferred()
    const server = {
      done: done.promise,
      cleanupProved: false,
      hostBudget: host.budget,
      http: async (_lane: string, route: string) => {
        if (route === '/api/v1/models') return { items: [] }
        if (route === '/api/v1/config') return {}
        if (route === '/api/v1/sessions') {
          nativeCreates++
          return { id: 'native-v2', metadata: { cwd: path } }
        }
        throw new Error('Unexpected synthetic route')
      },
      closeLane: async () => {},
      closeSocket: async () => {},
      close: async () => {
        serverCloses++
        server.cleanupProved = true
        done.resolve()
      },
    }
    return server as unknown as KimiServer
  })
  const initialize = vi
    .spyOn(
      KimiRuntime.prototype as unknown as { initialize(): Promise<void> },
      'initialize',
    )
    .mockImplementation(async () => {
      initialized++
    })
  const options = {
    commitRecords: async () => {
      throw new Error('No sink expected')
    },
  } as unknown as KimiAdapterOptions
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(
        KimiRuntime.create(
          { ...session, context: 'a'.repeat(8192) } as HarnessSession,
          authority,
          host,
          options,
          () => {},
          false,
        ),
      ).rejects.toMatchObject({
        code: 'kimi_startup_failed',
        message: 'kimi_resource_limit',
      })
      await tick()
      expect(initialized).toBe(0)
      for (const key of [
        'hostRetainedBytes',
        'hostHomes',
        'hostSessions',
        'hostResidentSessions',
      ] as const)
        expect(host.budget.count(key)).toBe(0)
    }
    const valid = await KimiRuntime.create(
      session,
      authority,
      host,
      options,
      () => {},
      false,
    )
    expect(initialized).toBe(1)
    expect(valid.binding.providerSessionId).toBe('native-v2')
    await valid.kill()
    await tick()
    expect(nativeCreates).toBe(4)
    expect(serverCloses).toBe(4)
    for (const key of [
      'hostRetainedBytes',
      'hostHomes',
      'hostSessions',
      'hostResidentSessions',
    ] as const)
      expect(host.budget.count(key)).toBe(0)
  } finally {
    await host.close()
    start.mockRestore()
    initialize.mockRestore()
    await rm(path, { recursive: true, force: true })
  }
})

test.each(['local', 'host'] as const)(
  'receipt refusal rolls back identity state when the %s failure reserve cannot fit',
  async (kind) => {
    const host = new KimiHostOwner(),
      budget = new KimiBudget(host.budget.limits),
      done = deferred(),
      server = { done: done.promise, cleanupProved: false }
    const runtime = Reflect.construct(KimiRuntime, [
      {
        id: 'receipt-reservation',
        cwd: '/inert',
        provider: 'kimi',
        accountId: 'synthetic',
      },
      { selected: { account: { config: {} } }, environment: {} },
      host,
      { server },
      scope,
      catalog,
      {
        commitRecords: async () => {
          throw new Error('No sink expected')
        },
      },
      () => {},
      budget,
    ]) as KimiRuntime
    const owner = kind === 'local' ? budget : host.budget
    const key = kind === 'local' ? 'retainedBytes' : 'hostRetainedBytes'
    const release = owner.reserve(
      key,
      owner.limits[key] - owner.count(key) - 2048,
    )
    const localBefore = budget.count('retainedBytes'),
      hostBefore = host.budget.count('hostRetainedBytes')
    try {
      for (let index = 0; index < 10; index++) {
        expect(() => runtime.prompt('No native admission')).toThrow(
          'Kimi limit reached',
        )
        expect(budget.count('retainedBytes')).toBe(localBefore)
        expect(host.budget.count('hostRetainedBytes')).toBe(hostBefore)
        expect(budget.count('promptReceipts')).toBe(0)
      }
    } finally {
      release()
      server.cleanupProved = true
      done.resolve()
      await tick()
      await host.close()
      expect(budget.count('retainedBytes')).toBe(0)
      expect(host.budget.count('hostRetainedBytes')).toBe(0)
    }
  },
)

test.each(['blob_begin', 'blob_chunk', 'blob_http'] as const)(
  'upload retains multipart and remote storage during cancelled %s',
  async (stage) => {
    await heldUpload(stage, 'cancel')
  },
)
test.each(['blob_begin', 'blob_chunk', 'blob_http'] as const)(
  'upload retains multipart and remote storage during timed-out %s',
  async (stage) => {
    await heldUpload(stage, 'timeout')
  },
)

async function heldUpload(stage: string, outcome: 'cancel' | 'timeout') {
  const host = new KimiHostOwner({
    limits: { httpMs: 15, guardianControlMs: 15 },
  })
  const budget = new KimiBudget(host.budget.limits)
  const controller = new AbortController(),
    entered = deferred(),
    gate = deferred()
  const commands: string[] = [],
    deleted: string[] = []
  let remote: Buffer | undefined,
    remoteSize = 0,
    held = false,
    releaseOther = () => {},
    readCalls = 0
  const server = Object.create(KimiServer.prototype) as KimiServer
  Object.assign(server, {
    hostBudget: host.budget,
    stopped: false,
    blobReleases: new Set(),
    transfers: new Set(),
    rpc: async (
      message: { op: string; sizeBytes?: number },
      _ms: unknown,
      physicalOnly: boolean,
    ) => {
      commands.push(message.op)
      expect(physicalOnly).toBe(true)
      if (message.op === 'blob_begin') {
        remoteSize = message.sizeBytes!
        remote = Buffer.alloc(remoteSize)
      }
      if (message.op === stage) {
        held = true
        entered.resolve()
        await gate.promise
        held = false
      }
      if (message.op === 'blob_release' || message.op === 'blob_http')
        remote = undefined
      return message.op === 'blob_http' ? { id: 'late-native-file' } : {}
    },
  })
  const originalHttp = server.http.bind(server)
  server.http = (lane, path, options = {}, ownership) => {
    if (options.method === 'DELETE') {
      deleted.push(path)
      return Promise.resolve({})
    }
    return originalHttp(lane, path, options, ownership)
  }
  const transfers = (server as unknown as { transfers: Set<Promise<unknown>> })
    .transfers
  const part = {
    type: 'attachment' as const,
    attachmentId: 'owned-v2',
    mime: 'image/png',
  }
  const preparing = prepareInput(
    [part],
    'v2-upload',
    { lane: 'lane', server } as KimiLease,
    host,
    budget,
    async () => ({
      mime: 'image/png',
      name: 'synthetic.png',
      path: '/inert',
      sizeBytes: 1024,
      readBytes: async () => {
        readCalls++
        return Buffer.alloc(1024, 7)
      },
    }),
    controller.signal,
    async () => {
      throw new Error('Late file deletion must succeed')
    },
  )
  void preparing.catch(() => {})
  try {
    await entered.promise
    expect(readCalls).toBe(1)
    expect(host.budget.count('hostAttachmentBytes')).toBe(1024 + 2 * remoteSize)
    if (outcome === 'cancel') controller.abort()
    await expect(preparing).rejects.toMatchObject({
      code: outcome === 'cancel' ? 'kimi_cancelled' : 'kimi_deadline',
    })
    expect(held).toBe(true)
    expect(remote?.length).toBe(remoteSize)
    expect(transfers.size).toBe(1)
    expect(host.budget.count('hostAttachmentBytes')).toBe(2 * remoteSize)
    expect(host.budget.count('hostIpcBytes')).toBe(
      stage === 'blob_chunk' ? Math.ceil(remoteSize / 3) * 8 : 0,
    )
    releaseOther = host.budget.reserve(
      'hostAttachmentBytes',
      host.budget.limits.hostAttachmentBytes -
        host.budget.count('hostAttachmentBytes'),
    )
    const competing = prepareInput(
      [part],
      'v2-competing',
      { lane: 'other-lane', server } as KimiLease,
      host,
      new KimiBudget(host.budget.limits),
      async () => ({
        mime: 'image/png',
        name: 'other.png',
        path: '/inert',
        sizeBytes: 1,
        readBytes: async () => {
          throw new Error('Refuse before allocation')
        },
      }),
      new AbortController().signal,
      async () => {},
    )
    await expect(competing).rejects.toMatchObject({
      code: 'kimi_resource_limit',
    })
    expect(host.budget.count('hostAttachmentBytes')).toBe(
      host.budget.limits.hostAttachmentBytes,
    )
    releaseOther()
    gate.resolve()
    await Promise.allSettled(transfers)
    expect(deleted).toEqual(
      stage === 'blob_http' ? ['/api/v1/files/late-native-file'] : [],
    )
    expect(commands.filter((op) => op === 'blob_http')).toHaveLength(
      stage === 'blob_http' ? 1 : 0,
    )
  } finally {
    controller.abort()
    releaseOther()
    gate.resolve()
    await preparing.catch(() => {})
    await Promise.allSettled(transfers)
    await host.close()
    await tick()
  }
  expect(remote).toBeUndefined()
  expect(held).toBe(false)
  expect(transfers.size).toBe(0)
  for (const key of [
    'hostAttachmentBytes',
    'hostIpcBytes',
    'hostTimers',
    'hostAttachmentLoads',
  ] as const)
    expect(host.budget.count(key)).toBe(0)
}

test('physical upload RPC holds the original write after an early reply and its logical deadline', async () => {
  const host = new KimiHostOwner({ limits: { guardianControlMs: 5 } })
  const pending = new Map<string, { resolve(value: unknown): void }>(),
    write = deferred()
  let sent: Record<string, unknown> | undefined,
    sendOptions: unknown,
    complete = false
  const server = Object.create(KimiServer.prototype) as KimiServer
  Object.assign(server, {
    hostBudget: host.budget,
    stopped: false,
    ordinal: 0,
    pending,
    httpReleases: new Map(),
    ipc: {
      send: (message: Record<string, unknown>, options: unknown) => {
        sent = message
        sendOptions = options
        return write.promise
      },
    },
  })
  const work = server
    .rpc({ op: 'blob_chunk', data: 'YWJj' }, 5, true)
    .then(() => {
      complete = true
    })
  try {
    pending.get(sent!.id as string)!.resolve({})
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sendOptions).toBeUndefined()
    expect(complete).toBe(false)
    write.resolve()
    await work
    expect(complete).toBe(true)
  } finally {
    write.resolve()
    await work
    await host.close()
  }
})
