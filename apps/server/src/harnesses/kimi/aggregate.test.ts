import { expect, test, vi } from 'vitest'
import { KimiBudget, kimiLimits, jsonBytes, type KimiLimits } from './limits.js'
import { KimiHostOwner, type KimiLease } from './host.js'
import { KimiRuntime } from './runtime.js'
import { KimiRecords, digest } from './records.js'
import { KimiReplay } from './transcript.js'
import { preserveMessage, readCatalog, readHistoryPage } from './discovery.js'
import type { KimiRoot, KimiChildOwner } from './types.js'
import type { KimiFrame } from './wire.js'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const root: KimiRoot = {
  runId: 'run',
  turnId: 'turn',
  operationId: 'operation',
}
function runtimeFixture(limits: Partial<KimiLimits> = {}) {
  const host = new KimiHostOwner({ limits }),
    budget = new KimiBudget(host.budget.limits),
    done = deferred()
  const server = { done: done.promise, cleanupProved: false }
  const sink = vi.fn(async (input: { expectedOrdinal: number }) => ({
    ordinal: input.expectedOrdinal + 1,
    disposition: 'committed' as const,
  }))
  const runtime = Reflect.construct(KimiRuntime, [
    {
      id: 'aggregate',
      cwd: '/inert',
      provider: 'kimi',
      accountId: 'synthetic',
    },
    { selected: { account: { config: {} } }, environment: {} },
    host,
    { server },
    {
      provider: 'kimi',
      accountId: 'synthetic',
      cwd: '/inert',
      providerSessionId: 'native',
    },
    {
      version: '0.34.0',
      models: [],
      commands: { status: 'unsupported', reason: 'synthetic' },
    },
    { commitRecords: sink },
    () => {},
    budget,
  ]) as KimiRuntime
  const internal = runtime as unknown as {
    child(frame: KimiFrame): Promise<void>
    children: Map<string, { owner: KimiChildOwner; finished: boolean }[]>
    toolOwners: Map<string, KimiRoot>
    records: KimiRecords
    transcript: { apply(frame: KimiFrame): Promise<void> }
    transcriptPending: { frame: KimiFrame; release(): void }[]
    transcriptReady: boolean
    flushTranscript(): Promise<void>
  }
  return {
    host,
    budget,
    runtime,
    internal,
    sink,
    close: async () => {
      internal.records.close()
      server.cleanupProved = true
      done.resolve()
      await tick()
      await host.close()
      expect(host.budget.count('hostRetainedBytes')).toBe(0)
    },
  }
}
function childFrame(
  index: number,
  parent: string,
  type = 'subagent.spawned',
): KimiFrame {
  return {
    type,
    seq: index + 1,
    epoch: 'epoch',
    session_id: 'native',
    payload: {
      subagentId: `agent-${index}`,
      parentAgentId: parent,
      parentToolCallId: `tool-${index}`,
    },
  } as KimiFrame
}

test('native tool edges admit depth eight, refuse depth nine, and bound child terminal tombstones', async () => {
  const f = runtimeFixture({ childOwnerTombstones: 2 })
  let owner = root,
    parent = 'main'
  try {
    for (let index = 0; index < 8; index++) {
      f.internal.toolOwners.set(digest([parent, `tool-${index}`]), owner)
      f.internal.records.checkpoint = {
        ...f.internal.records.checkpoint,
        transcripts: {
          ...f.internal.records.checkpoint.transcripts,
          [`agent-${index}`]: 0,
        },
      }
      await f.internal.child(childFrame(index, parent))
      const child = f.internal.children.get(`agent-${index}`)![0].owner
      expect(child.parentChildId).toBe(owner.childId)
      expect(child.operationId).toBe(root.operationId)
      owner = child
      parent = `agent-${index}`
    }
    expect(f.budget.count('children')).toBe(8)
    const calls = f.sink.mock.calls.length,
      retained = f.host.budget.count('hostRetainedBytes')
    f.internal.toolOwners.set(digest([parent, 'tool-8']), owner)
    await expect(f.internal.child(childFrame(8, parent))).rejects.toMatchObject(
      { code: 'kimi_child_depth_limit' },
    )
    expect(f.sink).toHaveBeenCalledTimes(calls)
    expect(f.host.budget.count('hostRetainedBytes')).toBe(retained)
    await f.internal.child(childFrame(0, 'main', 'subagent.completed'))
    await f.internal.child(childFrame(1, 'agent-0', 'subagent.failed'))
    expect(f.budget.count('childOwnerTombstones')).toBe(2)
    const terminalCalls = f.sink.mock.calls.length
    await expect(
      f.internal.child(childFrame(2, 'agent-1', 'subagent.failed')),
    ).rejects.toMatchObject({ code: 'kimi_resource_limit' })
    expect(f.sink).toHaveBeenCalledTimes(terminalCalls)
  } finally {
    await f.close()
  }
})

test('transcript drain measures combined sorting and applies arrivals during its held commit exactly once', async () => {
  const f = runtimeFixture(),
    gate = deferred(),
    entered = deferred()
  const applied: number[] = [],
    released: number[] = []
  const frames = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, index) => {
      const seq = to - index
      return {
        frame: {
          type: 'transcript.ops',
          seq: 1,
          epoch: 'epoch',
          session_id: 'native',
          volatile: true,
          payload: { type: 'transcript.ops', agent_id: 'main', seq, ops: [] },
        } as KimiFrame,
        release: () => released.push(seq),
      }
    })
  f.internal.transcriptPending.push(...frames(0, 32))
  const queue = f.internal.transcriptPending,
    originalSort = queue.sort.bind(queue)
  let comparisons = 0
  const sort = vi.spyOn(queue, 'sort').mockImplementation((compare) =>
    originalSort((a, b) => {
      comparisons++
      return compare!(a, b)
    }),
  )
  const apply = vi
    .spyOn(f.internal.transcript, 'apply')
    .mockImplementation(async (frame) => {
      const seq = Number(frame.payload.seq)
      if (seq === 1) {
        entered.resolve()
        await gate.promise
      }
      applied.push(seq)
      f.internal.records.checkpoint = {
        ...f.internal.records.checkpoint,
        transcripts: {
          ...f.internal.records.checkpoint.transcripts,
          main: seq,
        },
      }
    })
  try {
    f.internal.transcriptReady = true
    const work = f.internal.flushTranscript()
    await entered.promise
    queue.push(...frames(32, 64))
    gate.resolve()
    await work
    expect(applied).toEqual(Array.from({ length: 64 }, (_, index) => index + 1))
    expect(released).toEqual(applied)
    expect(sort).toHaveBeenCalledTimes(64)
    expect(comparisons).toBeGreaterThan(1000)
    expect(comparisons).toBeLessThan(4096)
  } finally {
    gate.resolve()
    sort.mockRestore()
    apply.mockRestore()
    await f.close()
  }
})

test('restored owners, replay frames, catalog values and history pages share one exact retained boundary', async () => {
  const host = new KimiHostOwner(),
    signal = new AbortController().signal
  const budgets = Array.from(
    { length: 4 },
    () => new KimiBudget(host.budget.limits),
  )
  const records = budgets.map(
    (budget, index) =>
      new KimiRecords(
        {
          sessionId: `home-${index}`,
          runtimeGeneration: `generation-${index}`,
          binding: {
            provider: 'kimi',
            accountId: `home-${index}`,
            cwd: `/inert/${index}`,
            providerSessionId: `native-${index}`,
          },
        },
        budget,
        host,
        async (input) => ({
          ordinal: input.expectedOrdinal + 1,
          disposition: 'committed',
        }),
        () => {},
        signal,
      ),
  )
  const replay = new KimiReplay(
    { seq: 0, epoch: 'epoch' },
    budgets[1],
    async () => {},
    host.budget,
  )
  let releaseOther = () => {},
    page: Awaited<ReturnType<typeof readHistoryPage>> | undefined,
    catalog: Awaited<ReturnType<typeof readCatalog>> | undefined,
    output: Awaited<ReturnType<typeof preserveMessage>> | undefined
  try {
    await records[0].restore(async () => ({
      committed: { ordinal: 0 },
      owners: [
        {
          agentId: 'main',
          root,
          providerTurnId: 'engine-1',
          sourceIdentity: {
            domain: 'live-engine',
            key: 'engine-1',
            revision: 'r1',
          },
        },
      ],
      pending: [],
    }))
    replay.push({
      type: 'turn.started',
      seq: 1,
      epoch: 'epoch',
      session_id: 'native-1',
      payload: { turnId: 1 },
    } as KimiFrame)
    const modelLease = {
      lane: 'models',
      server: {
        hostBudget: host.budget,
        http: async (_lane: string, path: string) =>
          path.endsWith('/models')
            ? {
                items: [
                  {
                    model: 'model',
                    provider: 'fixture',
                    max_context_size: 1024,
                  },
                ],
              }
            : {},
      },
    } as unknown as KimiLease
    catalog = await readCatalog(modelLease, budgets[2], signal)
    const message = {
      id: 'message',
      session_id: 'native-3',
      role: 'assistant',
      content: [{ type: 'text', text: 'x'.repeat(131072) }],
    }
    page = await readHistoryPage(
      {} as KimiLease,
      host,
      budgets[3],
      '/messages',
      signal,
      performance.now() + 10000,
      async () => ({ items: [message], has_more: false }),
    )
    const before = host.budget.count('hostRetainedBytes')
    releaseOther = host.budget.reserve(
      'hostRetainedBytes',
      host.budget.limits.hostRetainedBytes - before,
    )
    await expect(
      preserveMessage(
        message,
        'snapshot',
        records[3],
        {} as KimiLease,
        host,
        async () => {
          throw new Error('No media')
        },
      ),
    ).rejects.toMatchObject({ code: 'kimi_resource_limit' })
    expect(host.budget.count('hostRetainedBytes')).toBe(
      host.budget.limits.hostRetainedBytes,
    )
    releaseOther()
    output = await preserveMessage(
      message,
      'snapshot',
      records[3],
      {} as KimiLease,
      host,
      async () => {
        throw new Error('No media')
      },
    )
    expect(output.records).toHaveLength(1)
    expect(output.events).toEqual([])
    output.release()
    expect(host.budget.count('hostRetainedBytes')).toBe(before)
    await replay.acknowledge({ seq: 1, epoch: 'epoch' })
    expect(budgets[1].count('replayFrames')).toBe(0)
    expect(budgets[1].count('duplicateEntries')).toBe(1)
  } finally {
    releaseOther()
    output?.release()
    page?.release()
    catalog?.release()
    replay.dispose()
    records.forEach((value) => value.close())
    await host.close()
    await tick()
  }
  expect(host.budget.count('hostRetainedBytes')).toBe(0)
})

test('exact replay frame and byte thresholds retain a held apply and release each owner once', async () => {
  const frames = [1, 2, 3].map(
    (seq) =>
      ({
        type: 'turn.started',
        seq,
        epoch: 'epoch',
        session_id: 'native',
        payload: { turnId: seq },
      }) as KimiFrame,
  )
  const bytes = frames
    .slice(0, 2)
    .reduce((sum, frame) => sum + jsonBytes(frame, kimiLimits(), 1048576), 0)
  const host = new KimiHostOwner(),
    budget = new KimiBudget(
      kimiLimits({ replayFrames: 2, replayBytes: bytes, duplicateEntries: 1 }),
    ),
    gate = deferred(),
    entered = deferred()
  const apply = vi.fn(async (frame: KimiFrame) => {
    if (frame.seq === 1) {
      entered.resolve()
      await gate.promise
    }
  })
  const replay = new KimiReplay(
    { epoch: 'epoch', seq: 0 },
    budget,
    apply,
    host.budget,
  )
  try {
    replay.push(frames[0])
    replay.push(frames[1])
    expect(budget.count('replayBytes')).toBe(bytes)
    expect(() => replay.push(frames[2])).toThrow()
    const work = replay.acknowledge({ epoch: 'epoch', seq: 2 })
    await entered.promise
    expect(budget.count('replayFrames')).toBe(2)
    gate.resolve()
    await work
    expect(apply).toHaveBeenCalledTimes(2)
    expect(budget.count('duplicateEntries')).toBe(1)
    expect(budget.count('replayBytes')).toBe(0)
  } finally {
    gate.resolve()
    await replay.drain()
    replay.dispose()
    await host.close()
  }
  expect(host.budget.count('hostRetainedBytes')).toBe(0)
})
