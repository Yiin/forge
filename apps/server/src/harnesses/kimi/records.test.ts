import { expect, test } from 'vitest'
import { KimiRecords, digest, eventId, record } from './records.js'
import { KimiHostOwner } from './host.js'
import { KimiBudget, jsonBytes, type KimiLimits } from './limits.js'
import { KimiRuntime } from './runtime.js'
import { KimiTranscript } from './transcript.js'
import type { KimiRecordSink, KimiCheckpoint } from './types.js'
import {
  createCompletionHandle,
  isCompletionPersistenceFailure,
  type HarnessEvent,
} from '../types.js'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const scope = {
  sessionId: 'correction',
  runtimeGeneration: 'generation',
  binding: {
    provider: 'kimi',
    accountId: 'account',
    cwd: '/inert',
    providerSessionId: 'native',
  },
}
const root = { runId: 'run', turnId: 'turn', operationId: 'operation' }
function fixture(limits: Partial<KimiLimits> = {}) {
  const host = new KimiHostOwner({ limits }),
    budget = new KimiBudget(host.budget.limits),
    events: HarnessEvent[] = [],
    batches = new Map<string, { hash: string; ordinal: number }>()
  let ordinal = 0,
    checkpoint: KimiCheckpoint = { transcripts: {} }
  const sink: KimiRecordSink = async (input) => {
    const prior = batches.get(input.batchId)
    if (prior) {
      if (prior.hash !== input.contentHash)
        throw new Error('Conflicting durable bytes')
      return { ordinal: prior.ordinal, disposition: 'replayed' }
    }
    if (input.replayOnly || input.expectedOrdinal !== ordinal)
      throw new Error('Invalid durable transition')
    batches.set(input.batchId, { hash: input.contentHash, ordinal: ++ordinal })
    checkpoint = structuredClone(input.checkpoint)
    return { ordinal, disposition: 'committed' }
  }
  const create = () =>
    new KimiRecords(
      scope,
      budget,
      host,
      sink,
      (event) => events.push(event),
      new AbortController().signal,
    )
  const records = create()
  return {
    host,
    budget,
    records,
    events,
    create,
    state: () => ({
      committed: { ordinal },
      checkpoint,
      owners: [],
      pending: [],
    }),
    close: async () => {
      records.close()
      await host.close()
    },
  }
}
test('a durable retry after cache eviction returns its original ordinal without duplicate publication or cursor regression', async () => {
  const f = fixture({ duplicateEntries: 1 })
  const event: HarnessEvent = {
    ...root,
    runtimeGeneration: scope.runtimeGeneration,
    deliveryId: '',
    itemId: 'text',
    type: 'text_delta',
    text: 'one',
  }
  await f.records.commit('old', [], [event], { transcripts: { main: 1 } })
  await f.records.commit('new', [], [], { transcripts: { main: 2 } })
  expect(
    await f.records.commit('old', [], [event], { transcripts: { main: 1 } }),
  ).toBe(1)
  expect(f.records.ordinal).toBe(2)
  expect(f.records.checkpoint.transcripts.main).toBe(2)
  expect(f.events).toHaveLength(1)
  f.records.close()
  const restarted = f.create()
  await restarted.restore(async () => f.state())
  expect(
    await restarted.commit('old', [], [event], { transcripts: { main: 1 } }),
  ).toBe(1)
  expect(restarted.ordinal).toBe(2)
  await expect(
    restarted.commit('old', [], [{ ...event, text: 'changed' }], {
      transcripts: { main: 1 },
    }),
  ).rejects.toThrow('Conflicting durable bytes')
  restarted.close()
  await f.close()
})
test('actual runtime finish waits for work admitted during a held drain and seals the original owner', async () => {
  const host = new KimiHostOwner(),
    budget = new KimiBudget(host.budget.limits),
    gates = [deferred(), deferred(), deferred()],
    entered = [deferred(), deferred(), deferred()]
  let calls = 0,
    completionSettled = false
  const records = new KimiRecords(
    scope,
    budget,
    host,
    async (input) => {
      const index = calls++
      entered[index].resolve()
      await gates[index].promise
      return { ordinal: input.expectedOrdinal + 1, disposition: 'committed' }
    },
    () => {},
    new AbortController().signal,
  )
  const transcript = new KimiTranscript(records, async () => {})
  const op = {
    root,
    providerTurn: '1',
    settled: false,
    release() {},
    candidateReleases: [],
    completion: {
      settle() {
        completionSettled = true
      },
    },
    terminal: deferred(),
  }
  const runtime = Object.create(KimiRuntime.prototype)
  Object.assign(runtime, {
    generation: scope.runtimeGeneration,
    host,
    budget,
    records,
    transcript,
    interactions: { expire: async () => {} },
    operations: new Map([['op', op]]),
  })
  const finishing = runtime.finish(op, { status: 'completed' })
  await entered[0].promise
  const second = records.commit('during-terminal', [])
  gates[0].resolve()
  await entered[1].promise
  await tick()
  const third = records.commit('during-held-drain', [])
  gates[1].resolve()
  await second
  await entered[2].promise
  await tick()
  expect(completionSettled).toBe(false)
  expect(host.budget.count('sinkCalls')).toBe(1)
  gates[2].resolve()
  await third
  await finishing
  expect(completionSettled).toBe(true)
  expect(records.ordinal).toBe(3)
  await expect(
    records.commit('late-owner', [
      record(scope, 'live-engine', 'late', 'late', {}, root),
    ]),
  ).rejects.toMatchObject({ code: 'kimi_owner_sealed' })
  transcript.close()
  records.close()
  await host.close()
})
test('published byte admission includes final generated delivery IDs with a fast sink', async () => {
  const event: HarnessEvent = {
    ...root,
    runtimeGeneration: scope.runtimeGeneration,
    deliveryId: '',
    itemId: 'text',
    type: 'text_delta',
    text: 'x',
  }
  const batchId = digest([scope.runtimeGeneration, undefined, 'boundary'])
  const normalized = {
    ...event,
    deliveryId: eventId(scope.runtimeGeneration, batchId, 0, event.type),
  } as HarnessEvent & { operationId?: string }
  delete normalized.operationId
  const probe = fixture(),
    bytes = jsonBytes(
      [normalized],
      probe.budget.limits,
      probe.budget.limits.sinkBatchBytes,
    )
  await probe.close()
  const exact = fixture({ publishedBytes: bytes })
  await exact.records.commit('boundary', [], [event])
  expect(exact.budget.count('publishedBytes')).toBe(bytes)
  await expect(
    exact.records.commit('extra', [], [event]),
  ).rejects.toMatchObject({ code: 'kimi_resource_limit' })
  expect(exact.events).toHaveLength(1)
  await exact.close()
  const below = fixture({ publishedBytes: bytes - 1 })
  await expect(
    below.records.commit('boundary', [], [event]),
  ).rejects.toMatchObject({ code: 'kimi_resource_limit' })
  expect(below.events).toEqual([])
  await below.close()
})

test('sealing one operation does not guess ownership from reused Forge run and turn display fields', async () => {
  const f = fixture()
  await f.records.drain(root)
  const next = { ...root, operationId: 'distinct-native-operation' }
  await f.records.commit(
    'next-operation',
    [record(scope, 'live-engine', 'next', 'owned', {}, next)],
    [
      {
        runId: next.runId,
        turnId: next.turnId,
        runtimeGeneration: scope.runtimeGeneration,
        deliveryId: '',
        itemId: 'next',
        type: 'text_delta',
        text: 'new operation',
      },
    ],
  )
  expect(f.events).toHaveLength(1)
  await expect(
    f.records.commit('late-original', [
      record(scope, 'live-engine', 'late', 'owned', {}, root),
    ]),
  ).rejects.toMatchObject({ code: 'kimi_owner_sealed' })
  await f.close()
})

test('actual runtime finish never settles completion after a required sink failure', async () => {
  const host = new KimiHostOwner(),
    budget = new KimiBudget(host.budget.limits)
  const completion = createCompletionHandle(
    { completionId: 'completion', runId: root.runId, turnId: root.turnId },
    { persistenceRejection: true },
  )
  const underlying = new Error('Required durable write failed')
  const records = new KimiRecords(
    scope,
    budget,
    host,
    async () => {
      throw underlying
    },
    () => {},
    new AbortController().signal,
  )
  const transcript = new KimiTranscript(records, async () => {})
  const op = {
    root,
    identity: {
      sessionId: scope.sessionId,
      receiptId: 'receipt',
      completionId: 'completion',
      runId: root.runId,
      turnId: root.turnId,
    },
    providerTurn: '1',
    settled: false,
    release() {},
    candidateReleases: [],
    completion,
    terminal: deferred(),
  }
  const runtime = Object.create(KimiRuntime.prototype)
  Object.assign(runtime, {
    generation: scope.runtimeGeneration,
    host,
    budget,
    records,
    transcript,
    interactions: { expire: async () => {} },
    operations: new Map([['op', op]]),
  })
  const finishing = runtime.finish(op, { status: 'completed' })
  void finishing.catch(() => {})
  const rejected = await completion.handle.catch((error: unknown) => error)
  await expect(finishing).rejects.toBe(rejected)
  expect(isCompletionPersistenceFailure(rejected)).toBe(true)
  expect(rejected).toMatchObject({
    underlying,
    persistence: {
      code: 'persistence_unknown',
      required: { state: 'unproved' },
    },
  })
  expect(op.settled).toBe(true)
  expect(records.ordinal).toBe(0)
  transcript.close()
  records.close()
  await host.close()
  expect(host.budget.count('sinkCalls')).toBe(0)
})

test('duplicate identity refusal rolls back cumulative admission before any sink call', async () => {
  const f = fixture({ duplicateBytes: 1 })
  await expect(
    f.records.commit('identity', [
      record(scope, 'local', 'test', 'test', { text: 'retained' }),
    ]),
  ).rejects.toMatchObject({ code: 'kimi_resource_limit' })
  expect(f.records.ordinal).toBe(0)
  for (const key of [
    'nativeRecords',
    'nativeRecordBytes',
    'publishedEvents',
    'publishedBytes',
    'duplicateEntries',
  ] as const)
    expect(f.budget.count(key), key).toBe(0)
  await f.close()
})

test('retained projection values from two homes share one host bound and release capacity exactly', async () => {
  const host = new KimiHostOwner({ limits: { hostRetainedBytes: 6000000 } })
  const make = (home: string) =>
    new KimiRecords(
      { ...scope, binding: { ...scope.binding, accountId: home } },
      new KimiBudget(host.budget.limits),
      host,
      async (input) => ({
        ordinal: input.expectedOrdinal + 1,
        disposition: 'committed',
      }),
      () => {},
      new AbortController().signal,
    )
  const a = make('home-a'),
    b = make('home-b'),
    base = host.budget.count('hostRetainedBytes')
  const size = Math.floor((host.budget.limits.hostRetainedBytes - base) / 2)
  const releaseA = a.retainItem(size, false),
    releaseB = b.retainItem(size, false)
  expect(host.budget.count('hostRetainedBytes')).toBe(base + 2 * size)
  expect(() => a.retainItem(2, false)).toThrow(
    'Kimi limit reached: hostRetainedBytes',
  )
  releaseA()
  const replacement = b.retainItem(size, false)
  releaseB()
  replacement()
  a.close()
  b.close()
  await host.close()
  expect(host.budget.count('hostRetainedBytes')).toBe(0)
})

test('fixed failure storage serves every admitted receipt, request, and child after ordinary output exhaustion', async () => {
  const f = fixture({ nativeRecords: 1, publishedEvents: 1 })
  const first = record(
    scope,
    'live-engine',
    'first',
    'notice',
    { text: 'ordinary' },
    root,
  )
  await f.records.commit(
    'ordinary',
    [first],
    [
      {
        ...root,
        runtimeGeneration: scope.runtimeGeneration,
        deliveryId: '',
        itemId: 'first',
        type: 'text_delta',
        text: 'ordinary',
      },
    ],
  )
  await expect(f.records.commit('exhausted', [first])).rejects.toBeDefined()
  f.records.retire()
  const outcome = {
    status: 'failed' as const,
    code: 'exhausted',
    message: 'Output limit reached',
  }
  const events: HarnessEvent[] = []
  for (let index = 0; index < f.budget.limits.promptReceipts; index++)
    events.push({
      runId: 'run',
      turnId: `turn-${index}`,
      runtimeGeneration: scope.runtimeGeneration,
      deliveryId: '',
      type: 'turn_completed',
      outcome,
    })
  for (let index = 0; index < f.budget.limits.interactions; index++)
    events.push({
      ...root,
      runtimeGeneration: scope.runtimeGeneration,
      deliveryId: '',
      itemId: `request-${index}`,
      type: 'request_cancelled',
      requestId: `request-${index}`,
      reason: 'Output limit reached',
    })
  for (let index = 0; index < f.budget.limits.children; index++)
    events.push({
      ...root,
      runtimeGeneration: scope.runtimeGeneration,
      deliveryId: '',
      itemId: `child-${index}`,
      childId: `child-${index}`,
      type: 'child_finished',
      outcome,
    })
  events.push({
    ...root,
    runtimeGeneration: scope.runtimeGeneration,
    deliveryId: '',
    itemId: 'failure',
    type: 'diagnostic',
    severity: 'error',
    code: 'exhausted',
    message: 'Output limit reached',
  })
  const entries = events.map((event, index) =>
    record(scope, 'local', ['terminal', index], 'terminal', event, {
      ...root,
      turnId: 'turnId' in event ? event.turnId : root.turnId,
    }),
  )
  await f.records.commit(
    'all-terminal-owners',
    entries,
    events,
    undefined,
    true,
  )
  expect(f.events).toHaveLength(1 + 33 + 64 + 64 + 1)
  expect(f.budget.count('publishedEvents')).toBe(1)
  await expect(
    f.records.commit('extra-terminal', [], [events[0]], undefined, true),
  ).rejects.toThrow('kimi_terminal_reserve_limit')
  await f.close()
  expect(f.host.budget.count('hostRetainedBytes')).toBe(0)
})

test('the complete sink envelope, including CAS metadata, is bounded before the callback', async () => {
  const reference = fixture(),
    entry = record(scope, 'local', 'metadata', 'test', { text: 'x' })
  const batchId = digest([scope.runtimeGeneration, undefined, 'metadata']),
    contentHash = digest({
      nativeRecords: [entry],
      events: [],
      checkpoint: undefined,
    }),
    checkpoint = { transcripts: {} }
  const bytes = jsonBytes(
    {
      scope,
      importId: undefined,
      batchId,
      contentHash,
      replayOnly: false,
      expectedOrdinal: 0,
      expectedCheckpoint: checkpoint,
      checkpoint,
      records: [entry],
      events: [],
    },
    reference.budget.limits,
    reference.budget.limits.sinkBatchBytes,
  )
  await reference.close()
  const exact = fixture({ sinkBatchBytes: bytes })
  await exact.records.commit('metadata', [entry])
  expect(exact.records.ordinal).toBe(1)
  await exact.close()
  const below = fixture({ sinkBatchBytes: bytes - 1 })
  await expect(below.records.commit('metadata', [entry])).rejects.toMatchObject(
    { code: 'kimi_json_bytes' },
  )
  expect(below.records.ordinal).toBe(0)
  expect(below.host.budget.count('sinkCalls')).toBe(0)
  await below.close()
  expect(below.host.budget.count('hostRetainedBytes')).toBe(0)
})
