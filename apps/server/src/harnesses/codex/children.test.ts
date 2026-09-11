import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { emptyTimeline, reduceTimeline } from '@forge/protocol/timeline'
import {
  peer,
  turn,
  turnFrame,
  itemFrame,
  notify,
  eventually,
} from './test-helpers.js'

const collaboration = (
  tool: string,
  id: string,
  target: string,
  threadId = 'root',
  turnId = 't1',
) =>
  itemFrame(
    {
      id,
      type: 'collabAgentToolCall',
      tool,
      status: 'completed',
      senderThreadId: threadId,
      receiverThreadIds: [target],
      agentsStates: {},
    },
    turnId,
    threadId,
  )
const child = (
  p: Awaited<ReturnType<typeof peer>>,
  id: string,
  parent = 'root',
) => ({
  ...p.thread,
  id,
  parentThreadId: parent,
  source: { subAgent: { thread_spawn: { parent_thread_id: parent } } },
})
async function active() {
  const p = await peer([{ method: 'turn/start', result: { turn: turn() } }])
  const h = await p.start()
  const receipt = await h.prompt('input', undefined, {
    runId: 'original-run',
    turnId: 'original-turn',
  })
  return { p, h, receipt }
}

describe('Codex native child ownership', () => {
  it.each(['followup', 'conflict'])(
    '69, 71: ambiguous %s evidence cannot move a known execution before its fixed deadline',
    async (kind) => {
      const { p, receipt } = await active()
      const timer = globalThis.setTimeout
      const realNow = performance.now.bind(performance)
      let offset = 0
      const now = vi
        .spyOn(performance, 'now')
        .mockImplementation(() => realNow() + offset)
      const timers = vi
        .spyOn(globalThis, 'setTimeout')
        .mockImplementation(((
          callback: (...args: unknown[]) => void,
          ms?: number,
          ...args: unknown[]
        ) =>
          timer(
            callback,
            ms && ms > 29000 && ms <= 30000 ? 250 : ms,
            ...args,
          )) as typeof setTimeout)
      try {
        await p.send([
          collaboration('spawnAgent', 'spawn', 'child'),
          turnFrame('started', 'child-a', 'inProgress', 'child'),
          collaboration('followupTask', 'followup', 'child'),
          ...(kind === 'conflict'
            ? [
                collaboration('followupTask', 'second-followup', 'child'),
                turnFrame('started', 'child-b', 'inProgress', 'child'),
              ]
            : []),
          turnFrame('started', 'child-a', 'inProgress', 'child'),
          itemFrame(
            { id: 'late-a', type: 'agentMessage', text: 'still A' },
            'child-a',
            'child',
          ),
          turnFrame('completed', 'child-a', 'completed', 'child'),
        ])
        await eventually(() =>
          p.events.some((event) => event.type === 'child_finished'),
        )
        const starts = p.events.filter(
          (event) => event.type === 'child_started',
        )
        expect(starts).toHaveLength(1)
        expect(
          p.events.find(
            (event) =>
              event.type === 'content_snapshot' &&
              event.providerItemId === 'late-a',
          ),
        ).toMatchObject({ childId: starts[0]!.childId, runId: 'original-run' })
        expect(p.events.some((event) => event.type === 'run_failed')).toBe(
          false,
        )
        offset = 31000
        expect(await receipt.completion).toMatchObject({
          status: 'failed',
          message: 'CODEX_OWNERSHIP_UNRESOLVED',
        })
        expect(
          p.events.filter((event) => event.type === 'child_started'),
        ).toHaveLength(1)
      } finally {
        now.mockRestore()
        timers.mockRestore()
      }
    },
  )
  it('19: replays recorded three-thread ordering and settles the root only at frame 144', async () => {
    const raw = (
      await readFile(
        new URL('./fixtures/recorded-multi-agent.jsonl', import.meta.url),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(raw).toHaveLength(144)
    const root = raw[2].result.thread.id as string
    const nativeTurn = raw[8].params.turn.id as string
    const first = raw[31].params.item.agentThreadId as string
    const second = raw[40].params.item.agentThreadId as string
    const p = await peer([], {
      threadResponse: {
        approvalPolicy: 'never',
        sandbox: { type: 'dangerFullAccess' },
      },
      options: { initialOptions: { permissionMode: 'yolo' } },
    })
    const remap = (value: unknown): unknown => {
      if (value === root) return 'root'
      if (value === nativeTurn) return 't1'
      if (value === '/fixture/workspace') return p.root
      if (Array.isArray(value)) return value.map(remap)
      if (value && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value).map(([key, val]) => [key, remap(val)]),
        )
      return value
    }
    await p.save([
      ...p.startup,
      { method: 'turn/start', result: { turn: turn() } },
      {
        method: 'thread/read',
        expected: { threadId: first, includeTurns: false },
        result: { thread: child(p, first) },
      },
      {
        method: 'thread/read',
        expected: { threadId: second, includeTurns: false },
        result: { thread: child(p, second) },
      },
    ])
    const h = await p.start()
    const receipt = await h.prompt('recorded sequence')
    const frames = (from: number, to: number) =>
      raw
        .slice(from, to)
        .filter((frame) => frame.method && frame.method !== 'thread/started')
        .map(remap)
    await p.send(frames(3, 104))
    await eventually(() => {
      const failure = p.events.find((event) => event.type === 'run_failed')
      if (failure) throw new Error(failure.message)
      return (
        p.events.filter((event) => event.type === 'child_finished').length === 1
      )
    })
    expect(p.events.some((event) => event.type === 'turn_completed')).toBe(
      false,
    )
    await p.send(frames(104, 134))
    await eventually(
      () =>
        p.events.filter((event) => event.type === 'child_finished').length ===
        2,
    )
    expect(p.events.some((event) => event.type === 'turn_completed')).toBe(
      false,
    )
    await p.send(frames(134, 144))
    expect((await receipt.completion).status).toBe('completed')
    const entries = p.events.map((event, index) => ({
      cursor: index + 1,
      event,
    }))
    const live = entries.reduce(
      (state, entry) => reduceTimeline(state, { kind: 'delta', ...entry }),
      emptyTimeline(),
    )
    const replay = reduceTimeline(emptyTimeline(), {
      kind: 'snapshot',
      cursor: entries.length,
      entries,
    })
    expect(replay.events).toEqual(live.events)
    expect(replay.terminal).toBe('completed')
  })

  it('20, 21, 67, 68, 70: child reuse keeps separate executions and late old-turn ownership', async () => {
    const { p, receipt } = await active()
    await p.send([
      collaboration('spawnAgent', 'spawn', 'child'),
      turnFrame('started', 'child-old', 'inProgress', 'child'),
      collaboration('followupTask', 'followup', 'child'),
      turnFrame('completed', 'child-old', 'completed', 'child'),
      turnFrame('started', 'child-new', 'inProgress', 'child'),
      turnFrame('completed'),
      turnFrame('started', 'wake'),
      itemFrame(
        { id: 'late-old', type: 'agentMessage', text: 'late old content' },
        'child-old',
        'child',
      ),
      turnFrame('completed', 'child-new', 'failed', 'child'),
      collaboration('sendMessage', 'to-root', 'root', 'child', 'child-new'),
      collaboration('wait', 'wait-child', 'child', 'root', 'wake'),
    ])
    await receipt.completion
    await eventually(
      () =>
        p.events.filter((event) => event.type === 'child_finished').length ===
        2,
    )
    const starts = p.events.filter((event) => event.type === 'child_started')
    expect(starts).toHaveLength(2)
    expect(starts[0]!.childId).not.toBe(starts[1]!.childId)
    expect(
      p.events.find(
        (event) =>
          event.type === 'content_snapshot' &&
          event.providerItemId === 'late-old',
      ),
    ).toMatchObject({
      childId: starts[0]!.childId,
      runId: 'original-run',
      turnId: 'original-turn',
    })
    expect(p.events.filter((event) => event.type === 'run_failed')).toEqual([])
    expect(
      p.events.filter((event) => event.type === 'turn_completed'),
    ).toHaveLength(1)
    expect(
      p.events.filter((event) => event.type === 'turn_started'),
    ).toHaveLength(2)
  })

  it('20: early child turns resolve metadata before routing their output', async () => {
    const p = await peer()
    await p.save([
      ...p.startup,
      { method: 'turn/start', result: { turn: turn() } },
      {
        method: 'thread/read',
        expected: { threadId: 'early', includeTurns: false },
        result: { thread: child(p, 'early') },
      },
    ])
    const h = await p.start()
    await h.prompt('input')
    await p.send([
      turnFrame('started', 'early-turn', 'inProgress', 'early'),
      itemFrame(
        { id: 'message', type: 'agentMessage', text: 'early' },
        'early-turn',
        'early',
      ),
      turnFrame('completed', 'early-turn', 'completed', 'early'),
    ])
    await eventually(() =>
      p.events.some((event) => event.type === 'child_finished'),
    )
    const start = p.events.find((event) => event.type === 'child_started')!
    expect(
      p.events.find((event) => event.type === 'content_snapshot'),
    ).toMatchObject({ childId: start.childId })
    expect(p.events.some((event) => event.type === 'turn_completed')).toBe(
      false,
    )
  })

  it('20, 67: nested children and sibling messages preserve immutable ancestry', async () => {
    const { p } = await active()
    await p.send([
      collaboration('spawnAgent', 'spawn-a', 'a'),
      turnFrame('started', 'a-turn', 'inProgress', 'a'),
      collaboration('spawnAgent', 'spawn-b', 'b'),
      turnFrame('started', 'b-turn', 'inProgress', 'b'),
      collaboration('spawnAgent', 'spawn-nested', 'nested', 'a', 'a-turn'),
      turnFrame('started', 'nested-turn', 'inProgress', 'nested'),
      collaboration('sendMessage', 'sibling', 'b', 'a', 'a-turn'),
      collaboration('wait', 'wait', 'nested', 'a', 'a-turn'),
    ])
    await eventually(
      () =>
        p.events.filter((event) => event.type === 'child_started').length === 3,
    )
    const children = p.events.filter((event) => event.type === 'child_started')
    expect(children[2]!.parentChildId).toBe(children[0]!.childId)
    expect(children[1]!.parentChildId).toBeUndefined()
  })

  it.each(['conflict', 'cycle', 'foreign'])(
    '20: %s ancestry retires the activation without a root fallback',
    async (kind) => {
      const { p, receipt } = await active()
      if (kind === 'foreign')
        await p.send([
          notify('thread/started', {
            thread: { ...child(p, 'child'), sessionId: 'foreign-tree' },
          }),
        ])
      else
        await p.send([
          collaboration('spawnAgent', 'spawn', 'child'),
          turnFrame('started', 'child-turn', 'inProgress', 'child'),
          kind === 'cycle'
            ? collaboration(
                'spawnAgent',
                'cycle',
                'child',
                'child',
                'child-turn',
              )
            : notify('thread/started', {
                thread: { ...child(p, 'child'), parentThreadId: 'other' },
              }),
        ])
      expect((await receipt.completion).status).toBe('failed')
      expect(
        p.events.filter((event) => event.type === 'turn_started'),
      ).toHaveLength(1)
    },
  )
})
