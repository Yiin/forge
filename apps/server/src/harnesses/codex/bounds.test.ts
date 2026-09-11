import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexBudget, MiB, idSchema, pathSchema, cursorSchema } from './wire.js'
import { CodexNormalizer } from './normalize.js'
import {
  peer,
  turn,
  turnFrame,
  itemFrame,
  notify,
  eventually,
  methods,
  type Step,
} from './test-helpers.js'

afterEach(() => vi.restoreAllMocks())
function countLimit(bucket: string, count: number) {
  const original = CodexBudget.prototype.charge
  vi.spyOn(CodexBudget.prototype, 'charge').mockImplementation(function (
    this: CodexBudget,
    name,
    bytes,
    maximum,
    limit,
  ) {
    return original.call(
      this,
      name,
      bytes,
      name === bucket ? count : maximum,
      limit,
    )
  })
}
const spawn = (id: string) =>
  itemFrame({
    id: `spawn-${id}`,
    type: 'collabAgentToolCall',
    tool: 'spawnAgent',
    status: 'completed',
    senderThreadId: 'root',
    receiverThreadIds: [id],
    agentsStates: {},
  })

describe('Codex limits through owned native peers', () => {
  it.each([32, 33])(
    'C2: reverse metadata discovery enforces depth %s before child admission',
    async (depth) => {
      const steps: Step[] = [
        { method: 'turn/start', result: { turn: turn('root-turn') } },
      ]
      const p = await peer(steps)
      const thread = (index: number) => ({
        ...p.thread,
        id: `child-${index}`,
        parentThreadId: index === 1 ? 'root' : `child-${index - 1}`,
      })
      for (let index = depth - 1; index >= 1; index--)
        steps.push({
          method: 'thread/read',
          expected: { threadId: `child-${index}`, includeTurns: false },
          result: { thread: thread(index) },
          delay: 20,
          ...(index === 1
            ? {
                after: [
                  itemFrame(
                    {
                      id: 'metadata-done',
                      type: 'agentMessage',
                      text: 'metadata complete',
                    },
                    'root-turn',
                  ),
                ],
              }
            : {}),
        })
      await p.save([...p.startup, ...steps])
      const h = await p.start()
      const receipt = await h.prompt('input')
      await p.send(
        Array.from({ length: depth }, (_, index) =>
          notify('thread/started', { thread: thread(depth - index) }),
        ),
      )
      await eventually(() =>
        p.events.some(
          (event) =>
            event.type === 'turn_completed' ||
            (event.type === 'content_snapshot' &&
              event.providerItemId === 'metadata-done'),
        ),
      )
      await p.send([
        itemFrame(
          {
            type: 'collabAgentToolCall',
            id: 'follow-deep-child',
            tool: 'followupTask',
            status: 'completed',
            senderThreadId: 'root',
            receiverThreadIds: [`child-${depth}`],
            agentsStates: {},
          },
          'root-turn',
        ),
        turnFrame('started', 'deep-turn', 'inProgress', `child-${depth}`),
      ])
      if (depth === 32) {
        await eventually(() =>
          p.events.some((event) => event.type === 'child_started'),
        )
        expect(
          p.events.filter((event) => event.type === 'child_started'),
        ).toMatchObject([{ providerChildId: 'child-32' }])
        expect(
          (await methods(p)).filter((method) => method === 'thread/read'),
        ).toHaveLength(31)
        await p.send([
          turnFrame('completed', 'deep-turn', 'completed', 'child-32'),
          turnFrame('completed', 'root-turn'),
        ])
        expect((await receipt.completion).status).toBe('completed')
      } else {
        expect(await receipt.completion).toMatchObject({
          status: 'failed',
          message: 'CODEX_CHILD_DEPTH',
        })
        expect(
          p.events.filter((event) => event.type === 'child_started'),
        ).toEqual([])
      }
    },
  )

  it.each(['buffers', 'metadata-waiters'])(
    '43, 74: unresolved %s permits the exact injected count and rejects the next frame',
    async (bucket) => {
      countLimit(bucket, 2)
      const p = await peer([
        { method: 'turn/start', result: { turn: turn() } },
        { method: 'thread/read', delay: 1000, result: {} },
      ])
      const h = await p.start()
      const receipt = await h.prompt('input')
      await p.send([
        turnFrame('started', 'unknown', 'inProgress', 'unknown'),
        itemFrame(
          { id: 'early', type: 'agentMessage', text: '' },
          'unknown',
          'unknown',
        ),
      ])
      await eventually(async () => (await methods(p)).includes('thread/read'))
      expect(p.events.some((event) => event.type === 'run_failed')).toBe(false)
      await p.send([
        itemFrame(
          { id: 'overflow', type: 'agentMessage', text: '' },
          'unknown',
          'unknown',
        ),
      ])
      expect((await receipt.completion).status).toBe('failed')
      expect(
        p.events.filter((event) => event.type === 'child_started'),
      ).toEqual([])
    },
  )

  it('75: failed metadata is never retried by later traffic for the same thread', async () => {
    const p = await peer([
      { method: 'turn/start', result: { turn: turn() } },
      {
        method: 'thread/read',
        error: { code: -32000, message: 'Fixture metadata unavailable' },
      },
    ])
    const h = await p.start()
    const receipt = await h.prompt('input')
    let failureRecorded = false
    const charge = CodexBudget.prototype.charge
    vi.spyOn(CodexBudget.prototype, 'charge').mockImplementation(function (
      this: CodexBudget,
      ...args
    ) {
      const release = charge.apply(this, args)
      if (args[0] === 'failed-metadata') failureRecorded = true
      return release
    })
    await p.send([turnFrame('started', 'unknown', 'inProgress', 'unknown')])
    await eventually(() => failureRecorded)
    await p.send([
      itemFrame(
        { id: 'late', type: 'agentMessage', text: '' },
        'unknown',
        'unknown',
      ),
    ])
    expect(await receipt.completion).toMatchObject({
      status: 'failed',
      message: 'CODEX_METADATA_UNAVAILABLE',
    })
    expect(
      (await methods(p)).filter((method) => method === 'thread/read'),
    ).toHaveLength(1)
  })
  it('43, 92: global account updates replace state; 32 rate buckets pass and the next bucket fails without a turn owner', async () => {
    const p = await peer([{ method: 'turn/start', result: { turn: turn() } }])
    const h = await p.start()
    const receipt = await h.prompt('input')
    await p.send([
      ...Array.from({ length: 100 }, () =>
        notify('account/updated', { authMode: null, planType: null }),
      ),
      ...Array.from({ length: 32 }, (_, index) =>
        notify('account/rateLimits/updated', {
          rateLimits: { limitId: `limit-${index}` },
        }),
      ),
      itemFrame({ id: 'marker', type: 'agentMessage', text: 'all admitted' }),
    ])
    await eventually(() =>
      p.events.some((event) => event.type === 'content_snapshot'),
    )
    expect(
      p.events.filter((event) => event.type === 'turn_started'),
    ).toHaveLength(1)
    expect(p.events.some((event) => event.type === 'run_failed')).toBe(false)
    await p.send([
      notify('account/rateLimits/updated', {
        rateLimits: { limitId: 'limit-32' },
      }),
    ])
    expect(await receipt.completion).toMatchObject({
      status: 'failed',
      message: 'CODEX_GLOBAL_RATE_LIMIT',
    })
  })

  it('73: ancestry accepts depth 32, then refuses a deeper child before indexing its execution', async () => {
    const p = await peer([{ method: 'turn/start', result: { turn: turn() } }])
    const h = await p.start()
    const receipt = await h.prompt('input')
    for (let depth = 1; depth <= 33; depth++) {
      const parent = depth === 1 ? 'root' : `child-${depth - 1}`
      const parentTurn = depth === 1 ? 't1' : `turn-${depth - 1}`
      await p.send([
        itemFrame(
          {
            id: `spawn-${depth}`,
            type: 'collabAgentToolCall',
            tool: 'spawnAgent',
            status: 'completed',
            senderThreadId: parent,
            receiverThreadIds: [`child-${depth}`],
            agentsStates: {},
          },
          parentTurn,
          parent,
        ),
        turnFrame('started', `turn-${depth}`, 'inProgress', `child-${depth}`),
      ])
      if (depth <= 32)
        await eventually(
          () =>
            p.events.filter((event) => event.type === 'child_started')
              .length === depth,
        )
    }
    expect(await receipt.completion).toMatchObject({
      status: 'failed',
      message: 'CODEX_CHILD_DEPTH',
    })
    expect(
      p.events.filter((event) => event.type === 'child_started'),
    ).toHaveLength(32)
  })
  it.each([
    'owners',
    'full-owners',
    'child-executions',
    'active-children',
    'lineage',
    'assignments',
  ])(
    '43, 72, 76: %s count admission retires without a ghost child',
    async (bucket) => {
      countLimit(
        bucket,
        bucket === 'owners' || bucket === 'full-owners' ? 3 : 2,
      )
      const p = await peer([{ method: 'turn/start', result: { turn: turn() } }])
      const h = await p.start()
      const receipt = await h.prompt('input')
      const runChildren = bucket !== 'assignments'
      for (const id of ['one', 'two'])
        await p.send([
          spawn(id),
          ...(runChildren ? [turnFrame('started', id, 'inProgress', id)] : []),
        ])
      await eventually(
        () =>
          p.events.filter(
            (event) =>
              event.type === (runChildren ? 'child_started' : 'tool_started'),
          ).length >= 2,
      )
      expect(p.events.some((event) => event.type === 'turn_completed')).toBe(
        false,
      )
      await p.send([
        spawn('three'),
        ...(runChildren
          ? [turnFrame('started', 'three', 'inProgress', 'three')]
          : []),
      ])
      expect((await receipt.completion).status).toBe('failed')
      expect(
        p.events.filter((event) => event.type === 'child_started'),
      ).toHaveLength(runChildren ? 2 : 0)
    },
  )

  it.each(['items', 'streams', 'reasoning-parts'])(
    '72: empty %s consume capacity before any fourth event',
    async (bucket) => {
      countLimit(bucket, 3)
      const p = await peer([{ method: 'turn/start', result: { turn: turn() } }])
      const h = await p.start()
      const receipt = await h.prompt('input')
      const frames = Array.from({ length: 3 }, (_, index) =>
        bucket === 'reasoning-parts'
          ? notify('item/reasoning/textDelta', {
              threadId: 'root',
              turnId: 't1',
              itemId: 'reasoning',
              contentIndex: index,
              delta: '',
            })
          : notify('item/agentMessage/delta', {
              threadId: 'root',
              turnId: 't1',
              itemId: `empty-${index}`,
              delta: '',
            }),
      )
      await p.send(frames)
      await eventually(
        () =>
          p.events.filter(
            (event) =>
              event.type === 'text_delta' || event.type === 'thought_delta',
          ).length === 3,
      )
      await p.send([
        bucket === 'reasoning-parts'
          ? notify('item/reasoning/textDelta', {
              threadId: 'root',
              turnId: 't1',
              itemId: 'reasoning',
              contentIndex: 3,
              delta: '',
            })
          : notify('item/agentMessage/delta', {
              threadId: 'root',
              turnId: 't1',
              itemId: 'fourth',
              delta: '',
            }),
      ])
      expect((await receipt.completion).status).toBe('failed')
      expect(
        p.events.filter(
          (event) =>
            event.type === 'text_delta' || event.type === 'thought_delta',
        ),
      ).toHaveLength(3)
    },
  )

  it('72, 76: finalized content releases payload but its native identity still consumes capacity', async () => {
    countLimit('items', 2)
    const p = await peer([{ method: 'turn/start', result: { turn: turn() } }])
    const h = await p.start()
    const receipt = await h.prompt('input')
    await p.send([
      itemFrame({ id: 'one', type: 'agentMessage', text: '' }),
      itemFrame({ id: 'two', type: 'agentMessage', text: '' }),
    ])
    await eventually(
      () =>
        p.events.filter((event) => event.type === 'content_snapshot').length ===
        2,
    )
    await p.send([
      itemFrame({ id: 'one', type: 'agentMessage', text: 'correction' }),
      itemFrame({ id: 'three', type: 'agentMessage', text: '' }),
    ])
    expect((await receipt.completion).status).toBe('failed')
    expect(
      p.events
        .filter((event) => event.type === 'content_snapshot')
        .map((event) => event.text),
    ).toEqual(['', '', 'correction'])
  })

  it('72: failed echo admission releases the caller identity before retry', async () => {
    countLimit('echoes', 2)
    const p = await peer(
      ['one', 'two', 'three'].map((id) => ({
        method: 'turn/start',
        result: { turn: turn(id, 'completed') },
      })),
    )
    const h = await p.start()
    await h.prompt('one')
    await h.prompt('two')
    const identity = { runId: 'retry-run', turnId: 'retry-turn' }
    await expect(h.prompt('third', undefined, identity)).rejects.toThrow(
      'ECHOES_LIMIT',
    )
    const first = (await p.trace()).find(
      (frame) => frame.method === 'turn/start',
    )!.params as { clientUserMessageId: string }
    await p.send([
      itemFrame(
        {
          type: 'userMessage',
          id: 'echo',
          clientId: first.clientUserMessageId,
          content: [{ type: 'text', text: 'one', text_elements: [] }],
        },
        'one',
      ),
      itemFrame({ type: 'plan', id: 'echo-read-marker', text: '' }, 'one'),
    ])
    await eventually(() =>
      p.events.some(
        (event) =>
          event.type === 'content_snapshot' &&
          event.providerItemId === 'echo-read-marker',
      ),
    )
    await h.prompt('third', undefined, identity)
    expect(
      (await methods(p)).filter((method) => method === 'turn/start'),
    ).toHaveLength(3)
  })

  it('74: deduplicates reads, permits four active reads and 64 queued thread IDs, then retires', async () => {
    const p = await peer([
      { method: 'turn/start', result: { turn: turn() } },
      ...Array.from({ length: 4 }, () => ({
        method: 'thread/read',
        delay: 1000,
        result: {},
      })),
    ])
    const h = await p.start()
    const receipt = await h.prompt('input')
    await p.send(
      Array.from({ length: 68 }, (_, index) =>
        turnFrame('started', `turn-${index}`, 'inProgress', `thread-${index}`),
      ),
    )
    await eventually(
      async () =>
        (await methods(p)).filter((method) => method === 'thread/read')
          .length === 4,
    )
    await p.send(
      Array.from({ length: 10 }, () =>
        turnFrame('started', 'turn-0', 'inProgress', 'thread-0'),
      ),
    )
    expect(
      (await methods(p)).filter((method) => method === 'thread/read'),
    ).toHaveLength(4)
    await p.send([turnFrame('started', 'over', 'inProgress', 'thread-over')])
    expect((await receipt.completion).status).toBe('failed')
    expect(
      p.events.filter((event) => event.type === 'child_started'),
    ).toHaveLength(0)
  })

  it('72: permits 128 pending callbacks and fails the next native request visibly', async () => {
    const p = await peer([{ method: 'turn/start', result: { turn: turn() } }])
    const h = await p.start()
    const receipt = await h.prompt('input')
    const callback = (id: number) => ({
      id,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'root',
        turnId: 't1',
        itemId: `tool-${id}`,
        startedAtMs: 1,
      },
    })
    await p.send(Array.from({ length: 128 }, (_, index) => callback(index)))
    await eventually(
      () =>
        p.events.filter((event) => event.type === 'permission_requested')
          .length === 128,
    )
    await p.send([callback(128)])
    expect((await receipt.completion).status).toBe('failed')
    expect(
      p.events.filter((event) => event.type === 'request_cancelled'),
    ).toHaveLength(128)
  })
})

describe('Codex exact UTF-8 and shared metadata admission', () => {
  it('43, 72, 76: aggregate live text/output reaches exactly 32 MiB and releases finalized payload', () => {
    const mapper = new CodexNormalizer(
      'generation',
      () => {},
      new CodexBudget(),
    )
    const owner = {
      runId: 'r',
      turnId: 'f',
      nativeThreadId: 'n',
      nativeTurnId: 't',
    }
    for (let index = 0; index < 8; index++)
      mapper.notification(owner, 'item/agentMessage/delta', {
        itemId: `item-${index}`,
        delta: 'x'.repeat(4 * MiB),
      })
    expect(mapper.state.liveBytes).toBe(32 * MiB)
    expect(() =>
      mapper.notification(owner, 'item/agentMessage/delta', {
        itemId: 'ninth',
        delta: 'x',
      }),
    ).toThrow('LIVE_CONTENT_LIMIT')
    mapper.item(owner, { id: 'item-0', type: 'agentMessage', text: '' }, true)
    mapper.notification(owner, 'item/agentMessage/delta', {
      itemId: 'ninth',
      delta: 'x',
    })
    expect(mapper.state.liveBytes).toBe(28 * MiB + 1)
    mapper.close()
    expect(mapper.state.liveBytes).toBe(0)
  })
  it('73: byte limits count multibyte identities, paths and cursors', () => {
    expect(idSchema.parse('😀'.repeat(256))).toHaveLength(512)
    expect(() => idSchema.parse('😀'.repeat(256) + 'x')).toThrow()
    expect(pathSchema.parse('/' + 'x'.repeat(16383))).toHaveLength(16384)
    expect(() => pathSchema.parse('/' + 'x'.repeat(16384))).toThrow()
    expect(cursorSchema.parse('x'.repeat(16384))).toHaveLength(16384)
    expect(() => cursorSchema.parse('x'.repeat(16385))).toThrow()
  })

  it('43: simultaneous record charges, reply growth, and failed admission preserve the aggregate byte budget', () => {
    const budget = new CodexBudget(1024)
    const first = budget.charge('callbacks', 256, 2, 1024)
    const second = budget.charge('owners', 512, 2, 1024)
    expect(budget.bytes).toBe(1024)
    expect(() => first.resize(257)).toThrow('LIMIT')
    expect(() => budget.charge('lineage', 0, 2, MiB)).toThrow('LIMIT')
    expect(budget.bytes).toBe(1024)
    second()
    first.resize(257)
    expect(budget.bytes).toBe(385)
    first()
    first()
    expect(budget.bytes).toBe(0)
  })
})
