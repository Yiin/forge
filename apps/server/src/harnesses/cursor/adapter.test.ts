import {
  mkdtemp,
  mkdir,
  rm,
  lstat,
  readFile,
  writeFile,
  readdir,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  CursorDurableSink,
  CursorNativeEnvelope,
  CursorReservation,
  CursorSelectedRecords,
} from './contracts.js'
import type { HarnessEvent, HarnessSession } from '../types.js'
import { deferred } from '../transport-test-helpers.js'

const fixture = vi.hoisted(() => ({ peer: '', starts: 0, closed: 0 }))
vi.mock('./container.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./container.js')>()
  const { NativeProcess } = await import('../process.js'),
    { CursorWire } = await import('./wire.js')
  return {
    ...original,
    CursorContainer: class {
      wire?: InstanceType<typeof CursorWire>
      process?: import('../process.js').NativeProcess
      private closing = false
      constructor(
        readonly launch: any,
        readonly owner: any,
        readonly directory: string,
        readonly resources: any,
        readonly limits: any,
        readonly frame: any,
        readonly reservation: CursorReservation,
        readonly discovery = false,
        readonly onFailure?: (error: Error) => void,
      ) {}
      async start() {
        fixture.starts++
        const creating = await lstat(
          join(this.directory, 'agents.ndjson'),
        ).then(
          () => false,
          () => true,
        )
        const started = await NativeProcess.start(
          {
            command: process.execPath,
            args: [fixture.peer, this.owner.generation],
            cwd: this.owner.cwd,
          },
          async (process) => {
            this.process = process
            this.wire = new CursorWire(
              process.child.stdin,
              process.child.stdout,
              this.owner.generation,
              this.limits,
              this.frame,
            )
            process.ownTransport(this.wire.transport)
            void this.wire.transport.done.then((error) => {
              if (!this.closing) this.onFailure?.(error)
            })
            return this.wire.request('initialize', {
              selected: this.launch.selected,
              owner: this.owner,
              directory: this.directory,
              creating,
              reservation: this.reservation,
            })
          },
        )
        return started.value
      }
      async close() {
        if (!this.process) return
        this.closing = true
        await this.wire?.request('close', {}, 2000).catch(() => {})
        await this.process.close()
        fixture.closed++
        this.process = undefined
      }
    },
  }
})
import {
  createCursorAdapter,
  createCursorResources,
  discoverCursor,
} from './index.js'

let root: string, stateRoot: string, home: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'forge-cursor-adapter-'))
  stateRoot = join(root, 'state')
  home = join(root, 'accounts', 'test')
  await mkdir(stateRoot, { mode: 0o700 })
  await mkdir(home, { recursive: true, mode: 0o700 })
  fixture.peer = join(root, 'peer.mjs')
  await promisify(execFile)(
    'bun',
    [
      'build',
      '--target=node',
      '--external',
      '@cursor/sdk',
      resolve('apps/server/test/fixtures/cursor-peer.ts'),
      '--outfile',
      fixture.peer,
    ],
    { timeout: 30000, maxBuffer: 4096 },
  )
  vi.stubEnv('FORGE_ACCOUNTS_DIR', join(root, 'accounts'))
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
const selected = (): CursorSelectedRecords => ({
  provider: 'cursor-test',
  selectionEpoch: 'epoch',
  harness: {
    name: 'Cursor',
    command: process.execPath,
    args: [],
    env: {},
    protocol: 'acp',
    adapterKind: 'native',
    enabled: true,
  },
  account: {
    id: 'account',
    harnessKey: 'cursor-test',
    kind: 'cursor',
    adapterKind: 'native',
    homePath: home,
    disabledAt: null,
    label: 'Test',
    orderIndex: 0,
    createdAt: 0,
    lastUsedAt: null,
    identity: null,
    config: null,
  },
  credential: { type: 'api-key', apiKey: 'synthetic-key' },
  accountEnv: {},
  settingSources: [],
})
function recordingSink() {
  const reservations = new Map<string, CursorReservation>(),
    records: CursorNativeEnvelope[] = [],
    order: string[] = []
  const sink: CursorDurableSink = {
    reserve: async (value) => {
      reservations.set(value.creationOwner.forgeSessionId, value)
      order.push(value.state)
      return value
    },
    readSession: async (id) => reservations.get(id) ?? null,
    confirm: async (value) => {
      const reservation = reservations.get(value.owner.forgeSessionId)!
      reservations.set(value.owner.forgeSessionId, {
        ...reservation,
        state: 'native-confirmed',
        record: value.record,
      })
      order.push('confirmed')
    },
    markDirty: async () => {
      order.push('dirty')
    },
    appendNative: async (value) => {
      records.push(value)
      order.push(value.kind)
      return { position: records.length }
    },
    seal: async () => {
      order.push('sealed')
      return { through: records.length }
    },
    flush: async (value) => {
      order.push('flushed')
      return { committedThrough: value.through }
    },
  }
  return { sink, reservations, records, order }
}
function session(id: string): HarnessSession {
  return {
    id,
    provider: 'cursor-test',
    accountId: 'account',
    cwd: root,
  } as HarnessSession
}
describe('Cursor adapter through real Node wire and sidecar runtime', () => {
  it('rejects malformed prompt, options, and identities before any admission effect', async () => {
    const recorded = recordingSink(),
      resources = createCursorResources(),
      events: HarnessEvent[] = []
    const loader = vi.fn(async () => {
      throw new Error('unexpected attachment')
    })
    const handle = await createCursorAdapter({
      selected: selected(),
      stateRoot,
      resources,
      sink: recorded.sink,
      loadAttachment: loader,
    }).spawn(session('strict-input'), (event) => events.push(event))
    const before = fixture.starts
    let reads = 0
    try {
      for (const input of [
        [
          {
            type: 'review_reference',
            url: 'https://example.invalid',
            title: 42,
          },
        ],
        [{ type: 'review_reference', url: ['https://example.invalid'] }],
        [
          {
            type: 'review_reference',
            get url() {
              reads++
              return 'https://example.invalid'
            },
          },
        ],
      ])
        expect(() =>
          handle.prompt(input as never, { permissionMode: 'auto' }),
        ).toThrow()
      for (const options of [
        null,
        { permissionMode: 'auto', model: 42 },
        { permissionMode: 'auto', extra: true },
        {
          permissionMode: 'auto',
          nativeModelParams: [{ id: 'x', value: '', extra: true }],
        },
        {
          permissionMode: 'auto',
          nativeModelParams: [
            { id: 'x', value: '' },
            { id: 'x', value: '' },
          ],
        },
      ])
        expect(() => handle.prompt('text', options as never)).toThrow()
      for (const identity of [
        null,
        { runId: 'run', turnId: 'turn', accountId: 'foreign' },
        { runId: '', turnId: 'turn' },
        { runId: 'run', turnId: '\u0000' },
        {
          get runId() {
            reads++
            return 'run'
          },
          turnId: 'turn',
        },
        new Proxy(
          { runId: 'run', turnId: 'turn' },
          {
            get() {
              reads++
              throw new Error('proxy accessed')
            },
          },
        ),
      ])
        expect(() =>
          handle.prompt('text', { permissionMode: 'auto' }, identity as never),
        ).toThrow()
      expect(reads).toBe(0)
      expect(events).toHaveLength(0)
      expect(recorded.reservations.size).toBe(0)
      expect(loader).not.toHaveBeenCalled()
      expect(fixture.starts).toBe(before)
      expect(
        Object.values(resources.snapshot()).every((value) => value === 0),
      ).toBe(true)
    } finally {
      await handle.kill()
    }
  })
  it('captures factory resources, sink methods and attachment loader before later caller changes', async () => {
    const recorded = recordingSink(),
      resources = createCursorResources(),
      replacement = vi.fn(async () => {
        throw new Error('replacement dependency')
      })
    let reads = 0
    const options = {
      selected: selected(),
      stateRoot,
      resources,
      sink: recorded.sink,
      loadAttachment: async () => ({
        attachmentId: 'image',
        mime: 'image/png',
        size: 8,
        read: async () => {
          reads++
          return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
        },
      }),
    }
    const adapter = createCursorAdapter(options)
    options.resources = createCursorResources()
    options.loadAttachment = replacement
    options.sink = {
      ...recorded.sink,
      readSession: replacement,
      reserve: replacement,
    }
    const originalReserve = recorded.sink.reserve
    recorded.sink.reserve = replacement
    const handle = await adapter.spawn(
      session('captured-dependencies'),
      () => {},
    )
    try {
      const receipt = await handle.prompt(
        [{ type: 'attachment', attachmentId: 'image', mime: 'image/png' }],
        { permissionMode: 'auto', model: 'test' },
      )
      expect((await receipt.completion).status).toBe('completed')
      expect(reads).toBe(1)
      expect(replacement).not.toHaveBeenCalled()
      expect(recorded.reservations.size).toBe(1)
      expect(
        resources.snapshot()['owners:captured-dependencies'],
      ).toBeGreaterThan(0)
      expect(options.resources.snapshot()).toEqual({})
    } finally {
      recorded.sink.reserve = originalReserve
      await handle.kill()
    }
    const loaded = await adapter.load!(
      { ...session('captured-dependencies'), binding: handle.binding! },
      () => {},
    )
    await loaded.kill()
    expect(replacement).not.toHaveBeenCalled()
  })
  it('drops settled prompt and native-result references while retaining bounded original owners', async () => {
    const recorded = recordingSink(),
      resources = createCursorResources(),
      id = 'retained-payloads'
    const handle = await createCursorAdapter({
      selected: selected(),
      stateRoot,
      resources,
      sink: recorded.sink,
      limits: { queuedPromptBytes: 8192 },
      loadAttachment: async () => {
        throw new Error('unexpected attachment')
      },
    }).spawn(session(id), () => {})
    try {
      for (let index = 0; index < 6; index++) {
        const receipt = await handle.prompt('x'.repeat(8192), {
          permissionMode: index === 5 ? 'yolo' : 'auto',
          model: 'test',
        })
        expect((await receipt.completion).status).toBe('completed')
        await vi.waitFor(() =>
          expect(resources.snapshot()[`queue:${id}`]).toBe(0),
        )
        const entries = [...(handle as any).tombstones.values()]
        expect(entries).toHaveLength(index + 1)
        for (const entry of entries)
          expect(Object.keys(entry).sort()).toEqual([
            'finished',
            'lastNativePosition',
            'owner',
          ])
        expect((handle as any).physicalWork.size).toBe(0)
      }
    } finally {
      await handle.kill()
    }
    expect((handle as any).tombstones.size).toBe(0)
    expect(
      Object.values(resources.snapshot()).every((value) => value === 0),
    ).toBe(true)
  })
  it('clears settled payloads and native settlement closures before held failure cleanup releases its owner', async () => {
    const recorded = recordingSink(),
      resources = createCursorResources()
    const entered = deferred<void>(),
      release = deferred<void>()
    const id = 'held-failure-payloads'
    const handle = await createCursorAdapter({
      selected: selected(),
      stateRoot,
      resources,
      sink: {
        ...recorded.sink,
        readSession: async () => {
          throw new Error('fixture preparation refused')
        },
      },
      limits: { queuedPromptBytes: 8192 },
      loadAttachment: async () => {
        throw new Error('unexpected attachment')
      },
    }).spawn(session(id), () => {})
    const starts = fixture.starts
    ;(handle as any).container = {
      close: async () => {
        entered.resolve()
        await release.promise
      },
    }
    const receipt = await handle.prompt('x'.repeat(8192), {
      permissionMode: 'auto',
      model: 'test',
    })
    let settled = false
    void receipt.completion.then(() => {
      settled = true
    })
    try {
      await entered.promise
      expect(fixture.starts).toBe(starts)
      expect(settled).toBe(false)
      const active = (handle as any).active
      expect(active.owner.runId).toBe(receipt.runId)
      expect(active.input).toBeUndefined()
      expect(active.result).toBeUndefined()
      expect(active.nativeResult).toBeUndefined()
      expect(active.resolveResult).toBeUndefined()
      expect(active.rejectResult).toBeUndefined()
      expect(resources.snapshot()[`queue:${id}`]).toBe(0)
      expect((handle as any).physicalWork.size).toBe(0)
      expect(resources.snapshot()[`owners:${id}`]).toBeGreaterThan(0)
      // Late cancellation must not require an already-released result closure.
      const cancelling = handle.cancel()
      release.resolve()
      await cancelling
      const result = await receipt.completion
      expect(result.status).toBe('interrupted')
      await handle.kill()
      expect(await receipt.completion).toBe(result)
      expect((handle as any).active).toBeUndefined()
      expect((handle as any).tombstones.size).toBe(0)
      expect(
        Object.values(resources.snapshot()).every((value) => value === 0),
      ).toBe(true)
    } finally {
      release.resolve()
      await receipt.completion
      await handle.kill()
    }
  })
  it('updates original late native positions after the completed Work becomes a payload-free tombstone', async () => {
    const recorded = recordingSink(),
      resources = createCursorResources(),
      held = deferred<void>()
    let entered = false,
      injected = false
    const handle = await createCursorAdapter({
      selected: selected(),
      stateRoot,
      resources,
      sink: {
        ...recorded.sink,
        appendNative: async (record, signal) => {
          if (record.deliveryId.endsWith(':late-position')) {
            entered = true
            await held.promise
          }
          return recorded.sink.appendNative(record, signal)
        },
      },
      loadAttachment: async () => {
        throw new Error('unexpected attachment')
      },
    }).spawn(session('late-position'), (event) => {
      if (event.type !== 'turn_completed' || injected) return
      injected = true
      const owner = (handle as any).tombstones.get(event.runId).owner
      ;(handle as any).frame({
        v: 1,
        type: 'native_record',
        generation: owner.generation,
        owner,
        record: {
          v: 1,
          owner,
          sourceSeq: 999,
          deliveryId: `${owner.attemptId}:late-position`,
          kind: 'sdk-record',
          payload: { source: 'lateDelta', update: { type: 'status' } },
        },
      })
    })
    try {
      const receipt = await handle.prompt('original', {
        permissionMode: 'auto',
        model: 'test',
      })
      expect((await receipt.completion).status).toBe('completed')
      await vi.waitFor(() => expect(entered).toBe(true))
      await vi.waitFor(() =>
        expect(resources.snapshot()['queue:late-position']).toBe(0),
      )
      const evidence = (handle as any).tombstones.get(receipt.runId)
      expect(Object.keys(evidence).sort()).toEqual([
        'finished',
        'lastNativePosition',
        'owner',
      ])
      const previous = evidence.lastNativePosition
      held.resolve()
      await (handle as any).nativeChain
      expect(evidence.lastNativePosition).toBe(previous + 1)
      expect(evidence.lastNativePosition).toBe(recorded.records.length)
      expect(evidence.owner.runId).toBe(receipt.runId)
      expect((await receipt.completion).status).toBe('completed')
    } finally {
      held.resolve()
      await handle.kill()
    }
  })
  it('expires one preparation deadline across held attachment and durable phases without late native admission', async () => {
    for (const phase of [
      'attachment',
      'readSession',
      'reserve',
      'confirm',
      'startup',
      'catalog',
    ] as const) {
      const recorded = recordingSink(),
        resources = createCursorResources(),
        held = deferred<void>()
      let entered = false
      const wait = async () => {
        entered = true
        await held.promise
      }
      const sink = { ...recorded.sink }
      if (
        phase === 'readSession' ||
        phase === 'reserve' ||
        phase === 'confirm'
      ) {
        const original = sink[phase]
        ;(sink as any)[phase] = async (...args: any[]) => {
          await wait()
          return (original as any)(...args)
        }
      }
      const handle = await createCursorAdapter({
        selected: {
          ...selected(),
          accountEnv:
            phase === 'startup'
              ? { TEST_SCENARIO: 'hold-metadata' }
              : phase === 'catalog'
                ? { TEST_SCENARIO: 'hold-models' }
                : {},
        },
        stateRoot,
        resources,
        sink,
        limits: { preparationMs: 1000, turnMs: 6000 },
        loadAttachment: async () => {
          await wait()
          return {
            attachmentId: 'image',
            mime: 'image/png',
            size: 8,
            read: async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          }
        },
      }).spawn(session(`preparation-${phase}`), () => {})
      try {
        const receipt = await handle.prompt(
          phase === 'attachment'
            ? [{ type: 'attachment', attachmentId: 'image', mime: 'image/png' }]
            : 'text',
          { permissionMode: 'auto', model: 'test' },
        )
        if (phase === 'startup' || phase === 'catalog') {
          await vi.waitFor(() =>
            expect((handle as any).container?.process?.diagnostics).toContain(
              phase === 'startup' ? 'fixture:metadata' : 'fixture:models',
            ),
          )
        } else await vi.waitFor(() => expect(entered).toBe(true))
        expect(await receipt.completion).toMatchObject({
          status: 'failed',
          code: 'cursor_preparation_timeout',
        })
        if (phase === 'startup' || phase === 'catalog')
          await (handle as any).callbackChain
        expect(resources.snapshot().callbacks).toBe(
          phase === 'startup' || phase === 'catalog' ? 0 : 1,
        )
        expect(handle.binding).toBeNull()
        const starts = fixture.starts
        held.resolve()
        await handle.kill()
        expect(fixture.starts).toBe(starts)
        expect(recorded.records).toHaveLength(0)
        expect(
          Object.values(resources.snapshot()).every((value) => value === 0),
        ).toBe(true)
      } finally {
        held.resolve()
        await handle.kill()
      }
    }
  }, 15000)
  it('reports a held flush deadline as unknown persistence while retaining its physical writer', async () => {
    const recorded = recordingSink(),
      resources = createCursorResources(),
      held = deferred<void>()
    let entered = false
    const handle = await createCursorAdapter({
      selected: selected(),
      stateRoot,
      resources,
      // The held flush, not preparation, must be what expires. Both budgets
      // cover a cold sidecar spawn under full-suite load; the turn budget stays
      // above the preparation budget so the turn deadline fires with the flush
      // still pending.
      limits: { turnMs: 4000, preparationMs: 3000 },
      sink: {
        ...recorded.sink,
        flush: async (value, signal) => {
          entered = true
          await held.promise
          return recorded.sink.flush(value, signal)
        },
      },
      loadAttachment: async () => {
        throw new Error('unexpected attachment')
      },
    }).spawn(session('flush-deadline'), () => {})
    try {
      const receipt = await handle.prompt('text', {
        permissionMode: 'auto',
        model: 'test',
      })
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 3000 })
      const outcome = await receipt.completion
      expect(outcome).toMatchObject({
        status: 'failed',
        code: 'cursor_persistence_unknown',
      })
      expect(resources.snapshot().callbacks).toBe(1)
      expect(recorded.order).not.toContain('dirty')
      held.resolve()
      await handle.kill()
      expect(await receipt.completion).toBe(outcome)
      expect(recorded.order).toContain('dirty')
      expect(
        Object.values(resources.snapshot()).every((value) => value === 0),
      ).toBe(true)
    } finally {
      held.resolve()
      await handle.kill()
    }
  }, 15000)
  it('captures selected records before caller mutation and preserves protocol selectors with a short credential key', async () => {
    const accountEnv = { TEST_SCENARIO: 'short-key' },
      authority = {
        ...selected(),
        credential: { type: 'api-key' as const, apiKey: 't' },
        accountEnv,
      },
      { sink } = recordingSink()
    const adapter = createCursorAdapter({
      selected: authority,
      stateRoot,
      resources: createCursorResources(),
      sink,
      loadAttachment: async () => {
        throw new Error('no attachment')
      },
    })
    accountEnv.TEST_SCENARIO = 'catalog-error'
    authority.account.id = 'foreign'
    authority.harness.enabled = false
    authority.harness.args.push('--require=/tmp/foreign.js')
    const handle = await adapter.spawn(session('immutable-selection'), () => {})
    try {
      expect(
        (
          await (
            await handle.prompt('captured', {
              permissionMode: 'auto',
              model: 'test',
            })
          ).completion
        ).status,
      ).toBe('completed')
      expect(handle.binding!.accountId).toBe('account')
      expect(handle.availableModels).toMatchObject([{ id: 'test' }])
    } finally {
      await handle.kill()
    }
  })
  it('preserves the original reservation after create, send, and final-output process crashes', async () => {
    for (const scenario of ['crash-create', 'crash-send', 'crash-result']) {
      const recorded = recordingSink(),
        resources = createCursorResources(),
        options = {
          selected: { ...selected(), accountEnv: { TEST_SCENARIO: scenario } },
          stateRoot,
          resources,
          sink: recorded.sink,
          loadAttachment: async () => {
            throw new Error('no attachment')
          },
        },
        id = `crash-${scenario}`,
        adapter = createCursorAdapter(options),
        events: HarnessEvent[] = [],
        handle = await adapter.spawn(session(id), (event) => events.push(event))
      try {
        const receipt = await handle.prompt('crash once', {
          permissionMode: 'auto',
          model: 'test',
        })
        expect((await receipt.completion).status).toBe('failed')
        await vi.waitFor(() =>
          expect(resources.snapshot()[`queue:${id}`]).toBe(0),
        )
        for (const entry of (handle as any).tombstones.values())
          expect(Object.keys(entry).sort()).toEqual([
            'finished',
            'lastNativePosition',
            'owner',
          ])
        expect(recorded.reservations.size).toBe(1)
        const reservation = recorded.reservations.get(id)!
        expect(
          (
            await readFile(
              join(stateRoot, reservation.storeRelativePath, 'agents.ndjson'),
              'utf8',
            )
          )
            .trim()
            .split('\n'),
        ).toHaveLength(1)
        expect(
          events.filter((event) => event.type === 'turn_completed'),
        ).toHaveLength(1)
        const before = fixture.starts,
          replacement = await adapter.spawn(session(id), () => {})
        try {
          expect(
            (
              await (
                await replacement.prompt('no second creation', {
                  permissionMode: 'auto',
                  model: 'test',
                })
              ).completion
            ).status,
          ).toBe('failed')
          expect(fixture.starts).toBe(before)
        } finally {
          await replacement.kill()
        }
      } finally {
        await handle.kill()
      }
    }
  })
  it('closes the old process before policy replacement even when SDK disposal rejects', async () => {
    const { sink } = recordingSink(),
      before = fixture.closed,
      starts = fixture.starts
    const handle = await createCursorAdapter({
      selected: {
        ...selected(),
        accountEnv: { TEST_SCENARIO: 'dispose-error' },
      },
      stateRoot,
      resources: createCursorResources(),
      sink,
      loadAttachment: async () => {
        throw new Error('no attachment')
      },
    }).spawn(session('policy-replacement'), () => {})
    try {
      expect(
        (
          await (
            await handle.prompt('auto', {
              permissionMode: 'auto',
              model: 'test',
            })
          ).completion
        ).status,
      ).toBe('completed')
      const binding = handle.binding
      expect(
        (
          await (
            await handle.prompt('yolo', {
              permissionMode: 'yolo',
              model: 'test',
            })
          ).completion
        ).status,
      ).toBe('completed')
      expect(fixture.closed).toBe(before + 1)
      expect(fixture.starts).toBe(starts + 2)
      expect(handle.binding).toEqual(binding)
    } finally {
      await handle.kill()
    }
  })
  it('rejects selected authority changes before process admission and exposes typed unsupported replies', async () => {
    const before = fixture.starts,
      { sink } = recordingSink()
    const options = {
      selected: selected(),
      stateRoot,
      resources: createCursorResources(),
      sink,
      loadAttachment: async () => {
        throw new Error('no attachment')
      },
    }
    for (const change of [
      (value: CursorSelectedRecords) => {
        value.harness.enabled = false
      },
      (value: CursorSelectedRecords) => {
        value.account.disabledAt = 1
      },
      (value: CursorSelectedRecords) => {
        value.account.kind = 'other' as never
      },
      (value: CursorSelectedRecords) => {
        value.account.harnessKey = 'foreign'
      },
      (value: CursorSelectedRecords) => {
        value.harness.args = ['--require=/tmp/injection.js']
      },
      (value: CursorSelectedRecords) => {
        value.harness.env = { HOME: '/tmp/foreign' }
      },
    ]) {
      const value = selected()
      change(value)
      expect(() =>
        createCursorAdapter({ ...options, selected: value }),
      ).toThrow()
    }
    const handle = await createCursorAdapter(options).spawn(
      session('unsupported'),
      () => {},
    )
    await expect(
      handle.replyPermission!({ type: 'denied', requestId: 'id' }),
    ).rejects.toMatchObject({ code: 'cursor_permissions_unsupported' })
    await expect(handle.replyQuestion!('id', {})).rejects.toMatchObject({
      code: 'cursor_questions_unsupported',
    })
    await handle.kill()
    expect(fixture.starts).toBe(before)
  })
  it('keeps held reservation and confirmation callbacks charged after cancellation without publishing a binding', async () => {
    for (const phase of ['reserve', 'confirm'] as const) {
      const recorded = recordingSink(),
        resources = createCursorResources(),
        gate = deferred<void>()
      let entered = false
      const sink: CursorDurableSink = {
        ...recorded.sink,
        reserve: async (value, signal) => {
          if (phase === 'reserve') {
            entered = true
            await gate.promise
          }
          return recorded.sink.reserve(value, signal)
        },
        confirm: async (value, signal) => {
          if (phase === 'confirm') {
            entered = true
            await gate.promise
          }
          return recorded.sink.confirm(value, signal)
        },
      }
      const options = {
          selected: selected(),
          stateRoot,
          resources,
          sink,
          loadAttachment: async () => {
            throw new Error('no attachment')
          },
        },
        id = `held-${phase}`,
        handle = await createCursorAdapter(options).spawn(session(id), () => {})
      try {
        const receipt = await handle.prompt('held', {
          permissionMode: 'auto',
          model: 'test',
        })
        await vi.waitFor(() => expect(entered).toBe(true))
        await handle.cancel()
        expect(resources.snapshot().callbacks).toBe(1)
        expect(handle.binding).toBe(null)
        gate.resolve()
        expect((await receipt.completion).status).toBe('interrupted')
        expect(handle.binding).toBe(null)
        expect(recorded.reservations.size).toBe(1)
        expect(recorded.records).toHaveLength(0)
      } finally {
        gate.resolve()
        await handle.kill()
      }
      const before = fixture.starts,
        replacement = await createCursorAdapter(options).spawn(
          session(id),
          () => {},
        )
      try {
        const receipt = await replacement.prompt('no replay', {
          permissionMode: 'auto',
          model: 'test',
        })
        expect((await receipt.completion).status).toBe('failed')
        expect(fixture.starts).toBe(before)
      } finally {
        await replacement.kill()
      }
    }
  })
  it('rejects argument count, per-argument bytes and total argument bytes before process admission', () => {
    const before = fixture.starts
    for (const [args, limits] of [
      [['--max-old-space-size=512', '--max-old-space-size=512'], {}],
      [['--max-old-space-size=512'], { argValueBytes: 8 }],
      [['--max-old-space-size=512'], { argBytes: 8 }],
    ] as const) {
      const value = selected()
      value.harness.args = [...args]
      expect(() =>
        createCursorAdapter({
          selected: value,
          stateRoot,
          limits,
          resources: createCursorResources(),
          sink: recordingSink().sink,
          loadAttachment: async () => {
            throw new Error('No attachment')
          },
        }),
      ).toThrow('node_arguments')
    }
    expect(fixture.starts).toBe(before)
  })
  it('bounds waiting prompts and retained queued text while reservation work stays physically active', async () => {
    for (const mode of ['count', 'bytes']) {
      const gate = deferred<void>(),
        recorded = recordingSink(),
        resources = createCursorResources()
      let entered = false
      const handle = await createCursorAdapter({
        selected: selected(),
        stateRoot,
        resources,
        limits: mode === 'count' ? { waiting: 1 } : { queuedPromptBytes: 5 },
        sink: {
          ...recorded.sink,
          reserve: async (value, signal) => {
            entered = true
            await gate.promise
            return recorded.sink.reserve(value, signal)
          },
        },
        loadAttachment: async () => {
          throw new Error('No attachment')
        },
      }).spawn(session(`queue-${mode}`), () => {})
      const before = fixture.starts
      try {
        const active = await handle.prompt('aaa', {
          permissionMode: 'auto',
          model: 'test',
        })
        await vi.waitFor(() => expect(entered).toBe(true))
        const queued =
          mode === 'count'
            ? await handle.prompt('bbb', {
                permissionMode: 'auto',
                model: 'test',
              })
            : undefined
        expect(() =>
          handle.prompt('ccc', { permissionMode: 'auto', model: 'test' }),
        ).toThrow(mode === 'count' ? 'queue_unavailable' : 'resource_limit')
        await handle.cancel()
        expect(resources.snapshot().callbacks).toBe(1)
        expect(
          resources.snapshot()[`queue:queue-${mode}`],
        ).toBeGreaterThanOrEqual(3)
        gate.resolve()
        expect((await active.completion).status).toBe('interrupted')
        if (queued) expect((await queued.completion).status).toBe('interrupted')
      } finally {
        gate.resolve()
        await handle.kill()
      }
      expect(fixture.starts).toBe(before)
      expect(resources.snapshot().callbacks).toBe(0)
    }
  })
  it('retains native completion when the submitted reply is lost and never resends', async () => {
    const authority = {
      ...selected(),
      accountEnv: { TEST_SCENARIO: 'drop-submitted' },
    }
    const { sink, records, reservations } = recordingSink(),
      before = fixture.starts
    const handle = await createCursorAdapter({
      selected: authority,
      stateRoot,
      resources: createCursorResources(),
      sink,
      limits: { controlMs: 500 },
      loadAttachment: async () => {
        throw new Error('no attachment')
      },
    }).spawn(session('lost-submitted'), () => {})
    try {
      const receipt = await handle.prompt('one send', {
        permissionMode: 'auto',
        model: 'test',
      })
      expect(await receipt.completion).toMatchObject({
        status: 'failed',
        code: 'submission_unknown',
      })
      expect(
        records.filter((record) => record.kind === 'terminal'),
      ).toHaveLength(1)
      expect(reservations.size).toBe(1)
      expect(fixture.starts).toBe(before + 1)
    } finally {
      await handle.kill()
    }
  })
  it('gives two sessions distinct native stores and rejects swapped indexes before resume admission', async () => {
    const { sink, reservations } = recordingSink(),
      resources = createCursorResources(),
      options = {
        selected: selected(),
        stateRoot,
        resources,
        sink,
        loadAttachment: async () => {
          throw new Error('no attachment')
        },
      },
      adapter = createCursorAdapter(options),
      handles = await Promise.all(
        ['distinct-a', 'distinct-b'].map((id) =>
          adapter.spawn(session(id), () => {}),
        ),
      )
    try {
      for (const handle of handles)
        expect(
          (
            await (
              await handle.prompt('separate', {
                permissionMode: 'auto',
                model: 'test',
              })
            ).completion
          ).status,
        ).toBe('completed')
      expect(handles[0].binding!.providerSessionId).not.toBe(
        handles[1].binding!.providerSessionId,
      )
      expect(reservations.get('distinct-a')!.creationOwner.storeId).not.toBe(
        reservations.get('distinct-b')!.creationOwner.storeId,
      )
      for (const handle of handles) await handle.kill()
      const records = await Promise.all(
        (await readdir(join(stateRoot, 'by-agent'))).map(async (name) => ({
          path: join(stateRoot, 'by-agent', name),
          bytes: await readFile(join(stateRoot, 'by-agent', name)),
        })),
      )
      const first = records.find(
          (row) =>
            JSON.parse(row.bytes.toString()).forgeSessionId === 'distinct-a',
        )!,
        second = records.find(
          (row) =>
            JSON.parse(row.bytes.toString()).forgeSessionId === 'distinct-b',
        )!
      await writeFile(first.path, second.bytes)
      const before = fixture.starts
      try {
        await expect(
          adapter.load!(
            { ...session('distinct-a'), binding: handles[0].binding! },
            () => {},
          ),
        ).rejects.toThrow('resume_index')
        expect(fixture.starts).toBe(before)
      } finally {
        await writeFile(first.path, first.bytes)
      }
      for (const [index, id] of ['distinct-a', 'distinct-b'].entries()) {
        const loaded = await adapter.load!(
          { ...session(id), binding: handles[index].binding! },
          () => {},
        )
        await loaded.kill()
      }
    } finally {
      for (const handle of handles) await handle.kill()
    }
  })
  it('discovers models without creating a session and preserves verified metadata when catalog access fails', async () => {
    const { sink, reservations } = recordingSink(),
      resources = createCursorResources(),
      base = selected()
    const successful = await discoverCursor(
      {
        selected: base,
        stateRoot,
        resources,
        sink,
        loadAttachment: async () => {
          throw new Error('no attachment')
        },
      },
      root,
    )
    expect(successful.readiness.auth).toBe('verified')
    expect(successful.catalog.status).toBe('ready')
    expect(reservations.size).toBe(0)
    const failed = await discoverCursor(
      {
        selected: { ...base, accountEnv: { TEST_SCENARIO: 'catalog-error' } },
        stateRoot,
        resources,
        sink,
        loadAttachment: async () => {
          throw new Error('no attachment')
        },
      },
      root,
    )
    expect(failed.readiness.auth).toBe('verified')
    expect(failed.catalog).toMatchObject({ status: 'failed', items: [] })
    expect(reservations.size).toBe(0)
  })
  it('fails an uncommitted or failed sealed prefix without a resend', async () => {
    for (const mode of ['stale-seal', 'failed-flush']) {
      const recorded = recordingSink(),
        resources = createCursorResources(),
        before = fixture.starts
      const sink = {
        ...recorded.sink,
        ...(mode === 'stale-seal'
          ? { seal: async () => ({ through: 0 }) }
          : {
              flush: async () => {
                throw new Error('fixture persistence failure')
              },
            }),
      }
      const handle = await createCursorAdapter({
        selected: selected(),
        stateRoot,
        resources,
        sink,
        loadAttachment: async () => {
          throw new Error('no attachment')
        },
      }).spawn(session(mode), () => {})
      try {
        const receipt = await handle.prompt('test', {
          permissionMode: 'auto',
          model: 'test',
        })
        expect(await receipt.completion).toMatchObject({
          status: 'failed',
          code: 'cursor_persistence_unknown',
        })
        expect(fixture.starts).toBe(before + 1)
        expect(
          recorded.records.filter((record) => record.kind === 'terminal'),
        ).toHaveLength(1)
      } finally {
        await handle.kill()
      }
    }
  })
  it('refuses synchronous admission when all physical callback slots are held', async () => {
    const resources = createCursorResources(),
      release = resources.charge('callbacks', 8, 8),
      { sink } = recordingSink(),
      events: HarnessEvent[] = []
    const handle = await createCursorAdapter({
      selected: selected(),
      stateRoot,
      resources,
      sink,
      loadAttachment: async () => {
        throw new Error('no attachment')
      },
    }).spawn(session('callback-limit'), (event) => events.push(event))
    try {
      expect(() =>
        handle.prompt('test', { permissionMode: 'auto', model: 'test' }),
      ).toThrow('resource_limit')
      expect(events).toHaveLength(0)
    } finally {
      release()
      await handle.kill()
    }
  })
  it('keeps FIFO receipts, final records and sealed flush order', async () => {
    const { sink, order, records } = recordingSink(),
      resources = createCursorResources(),
      events: HarnessEvent[] = []
    const adapter = createCursorAdapter({
      selected: selected(),
      stateRoot,
      resources,
      sink,
      loadAttachment: async () => {
        throw new Error('no attachment')
      },
    })
    const handle = await adapter.spawn(session('fifo'), (value) =>
      events.push(value),
    )
    try {
      const receipts = await Promise.all(
        ['A', 'B', 'C'].map((text, index) =>
          handle.prompt(
            text,
            { permissionMode: 'auto', model: 'test' },
            { runId: `fifo-${index}`, turnId: `turn-${index}` },
          ),
        ),
      )
      expect(new Set(receipts.map((row) => row.receiptId)).size).toBe(3)
      expect(
        (await Promise.all(receipts.map((row) => row.completion))).map(
          (row) => row.status,
        ),
      ).toEqual(['completed', 'completed', 'completed'])
      expect(
        events
          .filter((row) => row.type === 'turn_completed')
          .map((row) => row.runId),
      ).toEqual(['fifo-0', 'fifo-1', 'fifo-2'])
      expect(records.filter((row) => row.kind === 'terminal')).toHaveLength(3)
      expect(order.indexOf('creation-started')).toBeLessThan(
        order.indexOf('confirmed'),
      )
      expect(
        order.filter((value) =>
          ['terminal', 'sealed', 'flushed'].includes(value),
        ),
      ).toEqual([
        'terminal',
        'sealed',
        'flushed',
        'terminal',
        'sealed',
        'flushed',
        'terminal',
        'sealed',
        'flushed',
      ])
      expect(handle.binding?.providerSessionId).toMatch(/^agent-/)
    } finally {
      await handle.kill()
    }
    expect(
      Object.values(resources.snapshot()).every((value) => value === 0),
    ).toBe(true)
  })
  it('holds completion and physical charges until a durable append settles', async () => {
    const recorded = recordingSink(),
      gate = deferred<{ position: number }>(),
      resources = createCursorResources()
    let entered = false,
      finished = false
    const sink = {
      ...recorded.sink,
      appendNative: async (record: CursorNativeEnvelope) => {
        await recorded.sink.appendNative(record, new AbortController().signal)
        if (record.kind === 'terminal') {
          entered = true
          return gate.promise
        }
        return { position: recorded.records.length }
      },
    }
    const handle = await createCursorAdapter({
      selected: selected(),
      stateRoot,
      resources,
      sink,
      loadAttachment: async () => {
        throw new Error('no attachment')
      },
    }).spawn(session('held-sink'), () => {})
    try {
      const receipt = await handle.prompt('hold sink', {
        permissionMode: 'auto',
        model: 'test',
      })
      void receipt.completion.then(() => {
        finished = true
      })
      await vi.waitFor(() => expect(entered).toBe(true))
      expect(finished).toBe(false)
      expect(resources.snapshot().callbacks).toBe(1)
      gate.resolve({ position: recorded.records.length })
      expect((await receipt.completion).status).toBe('completed')
    } finally {
      gate.resolve({ position: recorded.records.length })
      await handle.kill()
    }
  })
  it('keeps cancelled attachment work charged and prevents native admission', async () => {
    const gate = deferred<{
        attachmentId: string
        mime: string
        size: number
        read: () => Promise<Uint8Array>
      }>(),
      resources = createCursorResources(),
      { sink } = recordingSink()
    let entered = false
    const before = fixture.starts
    const handle = await createCursorAdapter({
      selected: selected(),
      stateRoot,
      resources,
      sink,
      loadAttachment: async () => {
        entered = true
        return gate.promise
      },
    }).spawn(session('cancelled-attachment'), () => {})
    const receipt = await handle.prompt(
      [{ type: 'attachment', attachmentId: 'image', mime: 'image/png' }],
      { permissionMode: 'auto', model: 'test' },
    )
    await vi.waitFor(() => expect(entered).toBe(true))
    await handle.cancel()
    expect(resources.snapshot().callbacks).toBe(1)
    expect(fixture.starts).toBe(before)
    gate.resolve({
      attachmentId: 'image',
      mime: 'image/png',
      size: 8,
      read: async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    })
    expect((await receipt.completion).status).toBe('interrupted')
    await vi.waitFor(() =>
      expect(resources.snapshot()['images:cancelled-attachment']).toBe(0),
    )
    for (const entry of (handle as any).tombstones.values())
      expect(Object.keys(entry).sort()).toEqual([
        'finished',
        'lastNativePosition',
        'owner',
      ])
    await handle.kill()
    expect(resources.snapshot().callbacks).toBe(0)
    expect(fixture.starts).toBe(before)
  })
  it('resumes only the full original record and rejects a common binding alone', async () => {
    const { sink, reservations } = recordingSink(),
      resources = createCursorResources(),
      options = {
        selected: selected(),
        stateRoot,
        resources,
        sink,
        loadAttachment: async () => {
          throw new Error('no attachment')
        },
      }
    const adapter = createCursorAdapter(options),
      original = await adapter.spawn(session('resume'), () => {})
    const receipt = await original.prompt('first', {
      permissionMode: 'auto',
      model: 'test',
    })
    expect((await receipt.completion).status).toBe('completed')
    const binding = original.binding!
    await original.kill()
    const loaded = await adapter.load!(
      {
        ...session('resume'),
        binding: {
          providerSessionId: binding.providerSessionId,
          cwd: binding.cwd,
          accountId: binding.accountId,
          provider: binding.provider,
        },
      },
      () => {},
    )
    try {
      const next = await loaded.prompt('second', {
        permissionMode: 'auto',
        model: 'test',
      })
      expect((await next.completion).status).toBe('completed')
      expect(loaded.binding).toEqual(binding)
    } finally {
      await loaded.kill()
    }
    reservations.delete('resume')
    const before = fixture.starts
    await expect(
      adapter.load!({ ...session('resume'), binding }, () => {}),
    ).rejects.toThrow('resume_unavailable')
    expect(fixture.starts).toBe(before)
  })
})
