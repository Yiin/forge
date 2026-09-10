import { describe, expect, it } from 'vitest'
import { harnessEventSchema, type HarnessEvent } from '../src/harness.js'
import {
  foldTimeline,
  reduceTimeline,
  timelineFrameSchema,
  timelineRunKey,
  type TimelineFrame,
} from '../src/timeline.js'

const root = {
  runId: 'root-run',
  turnId: 'root-turn',
  runtimeGeneration: 'runtime-1',
}
const event = (deliveryId: string, fields: Record<string, unknown>) =>
  harnessEventSchema.parse({ ...root, deliveryId, ...fields })
const childItem = { childId: 'child-b', itemId: 'child-b-item' }
const start = event('root-start', { type: 'turn_started' })
const done = event('root-done', {
  type: 'turn_completed',
  outcome: { status: 'completed' },
})
const childStart = event('child-b-start', {
  type: 'child_started',
  ...childItem,
  parentToolCallId: 'child-a-spawning-tool',
  parentChildId: 'child-a',
  description: 'Inspect the parser',
})
const childDone = event('child-b-done', {
  type: 'child_finished',
  ...childItem,
  outcome: { status: 'failed', code: 'E_CHILD', message: 'Child task failed' },
})
const childUpdate = event('child-b-native-id', {
  type: 'child_updated',
  ...childItem,
  providerChildId: 'native-agent-b',
})
const lateItems = [
  event('child-user-1', {
    type: 'text_delta',
    ...childItem,
    itemId: 'child-user-text',
    role: 'user',
    text: 'Inspect ',
  }),
  event('child-user-2', {
    type: 'text_delta',
    ...childItem,
    itemId: 'child-user-text',
    role: 'user',
    text: 'the parser',
  }),
  event('child-thought', {
    type: 'thought_delta',
    ...childItem,
    text: 'Read the source first',
  }),
  event('child-tool-start', {
    type: 'tool_started',
    ...childItem,
    toolCallId: 'child-b-bash',
    name: 'Bash',
    input: { command: 'pwd' },
  }),
  event('child-tool-output', {
    type: 'tool_update',
    ...childItem,
    toolCallId: 'child-b-bash',
    status: 'completed',
    output: '/work/forge',
  }),
  event('child-assistant', {
    type: 'text_delta',
    ...childItem,
    itemId: 'child-assistant-text',
    text: 'The parser needs a test',
  }),
  event('child-plan', {
    type: 'plan',
    ...childItem,
    steps: [{ id: 'test-parser', title: 'Test the parser', status: 'running' }],
  }),
  event('child-file', {
    type: 'file_change',
    ...childItem,
    path: 'parser.test.ts',
    kind: 'created',
  }),
  event('child-usage', {
    type: 'usage',
    ...childItem,
    inputTokens: 4,
    outputTokens: 3,
    totalTokens: 7,
  }),
  event('child-permission', {
    type: 'permission_requested',
    ...childItem,
    request: {
      requestId: 'forge-permission-b',
      toolCallId: 'child-b-bash',
      title: 'Run test',
      options: [{ id: 'deny', label: 'Deny' }],
    },
  }),
  event('child-question', {
    type: 'question_requested',
    ...childItem,
    request: { requestId: 'forge-question-b', questions: [] },
  }),
  event('child-cancel-permission', {
    type: 'request_cancelled',
    ...childItem,
    requestId: 'forge-permission-b',
    reason: 'The command was cancelled',
  }),
  event('child-cancel-question', {
    type: 'request_cancelled',
    ...childItem,
    requestId: 'forge-question-b',
  }),
  childDone,
  childUpdate,
]
const history = [
  start,
  event('child-a-start', {
    type: 'child_started',
    itemId: 'child-a-item',
    childId: 'child-a',
    parentToolCallId: 'root-spawning-tool',
    providerChildId: 'native-agent-a',
    description: 'Inspect source',
  }),
  event('child-a-tool', {
    type: 'tool_started',
    itemId: 'child-a-tool-item',
    childId: 'child-a',
    toolCallId: 'child-a-spawning-tool',
    name: 'Agent',
    input: { task: 'Inspect the parser' },
  }),
  childStart,
  done,
  ...lateItems,
]
const frames = (events: HarnessEvent[]) =>
  events.map((event, i) => ({ kind: 'delta' as const, cursor: i + 1, event }))
const snapshot = (events: HarnessEvent[], cursor = events.length) => ({
  kind: 'snapshot' as const,
  cursor,
  entries: frames(events).map(({ cursor, event }) => ({ cursor, event })),
})
const wire = (frame: TimelineFrame) =>
  timelineFrameSchema.parse(JSON.parse(JSON.stringify(frame)))

describe('child timeline replay', () => {
  it('keeps a completed root settled across every late child delivery', () => {
    let state = foldTimeline(frames(history.slice(0, 5)))
    const completedRuns = state.runs
    for (const item of lateItems) {
      state = reduceTimeline(state, {
        kind: 'delta',
        cursor: state.cursor + 1,
        event: item,
      })
      expect(state.runs).toBe(completedRuns)
      expect(state.terminal).toBe('completed')
      expect(state.activeRunId).toBe('root-run')
      expect(state.activeTurnId).toBe('root-turn')
    }
    expect(state.events).toEqual(history)
    expect(
      state.runs.get(timelineRunKey('runtime-1', 'root-run'))?.turns,
    ).toEqual(
      new Map([
        ['root-turn', { phase: 'settled', outcome: { status: 'completed' } }],
      ]),
    )
  })

  it('retains nested ownership and separate late metadata deliveries through every snapshot boundary', () => {
    const expected = foldTimeline(frames(history).map(wire))
    for (let cut = 0; cut <= history.length; cut++) {
      const prefix = wire(snapshot(history.slice(0, cut)))
      const suffix = frames(history).slice(cut).map(wire)
      expect(foldTimeline([prefix, ...suffix])).toEqual({
        ...expected,
        snapshotCursor: cut,
      })
      expect(foldTimeline([...suffix, prefix])).toEqual({
        ...expected,
        snapshotCursor: cut,
      })
    }
    const childEvents = expected.events.filter(
      (item) => 'childId' in item && item.childId === 'child-b',
    )
    expect(childEvents[0]).toEqual(childStart)
    expect(childEvents.slice(-2)).toEqual([childDone, childUpdate])
    expect(childEvents.at(-1)).not.toHaveProperty('parentChildId')
    expect(childEvents[0]).toHaveProperty('parentChildId', 'child-a')
    expect(childEvents[0]).toHaveProperty(
      'parentToolCallId',
      'child-a-spawning-tool',
    )
    expect(childEvents.at(-1)).toHaveProperty(
      'providerChildId',
      'native-agent-b',
    )
    expect(
      expected.events.filter(
        (item) => item.type === 'text_delta' && item.role === 'user',
      ),
    ).toEqual(lateItems.slice(0, 2))
  })

  it('deduplicates late metadata deliveries without dropping child start or finish', () => {
    const state = foldTimeline([
      ...frames(history),
      { kind: 'delta', cursor: history.length, event: childUpdate },
      { kind: 'delta', cursor: history.length + 1, event: childUpdate },
    ])
    expect(state.events).toEqual(history)
    expect(state.cursor).toBe(history.length + 1)
    expect(
      reduceTimeline(state, wire(snapshot(history, history.length + 1))).events,
    ).toEqual(history)
  })

  it.each(['same run', 'new run'])(
    'keeps late child traffic on its spawning turn during a distinct wake in the %s',
    (mode) => {
      const wake = {
        runId: mode === 'same run' ? 'root-run' : 'wake-run',
        turnId: 'wake-turn',
      }
      let state = foldTimeline(
        frames([
          ...history,
          event('wake-accepted', {
            type: 'prompt_accepted',
            ...wake,
            receiptId: 'wake-receipt',
          }),
          event('wake-started', { type: 'turn_started', ...wake }),
        ]),
      )
      const beforeChild = state.runs
      const lateUpdate = event('child-b-parent-link', {
        type: 'child_updated',
        ...childItem,
        parentToolCallId: 'child-a-spawning-tool',
        parentChildId: 'child-a',
      })
      state = reduceTimeline(state, {
        kind: 'delta',
        cursor: state.cursor + 1,
        event: lateUpdate,
      })
      expect(state.runs).toBe(beforeChild)
      expect(state.activeRunId).toBe(wake.runId)
      expect(state.activeTurnId).toBe(wake.turnId)
      expect(state.terminal).toBeNull()
      expect(state.events.at(-1)).toMatchObject(root)
      state = reduceTimeline(state, {
        kind: 'delta',
        cursor: state.cursor + 1,
        event: event('wake-completed', {
          type: 'turn_completed',
          ...wake,
          outcome: { status: 'interrupted', reason: 'Wake cancelled' },
        }),
      })
      expect(state.terminal).toBe('interrupted')
      expect(
        state.runs
          .get(timelineRunKey('runtime-1', 'root-run'))
          ?.turns.get('root-turn'),
      ).toEqual({ phase: 'settled', outcome: { status: 'completed' } })
      expect(
        foldTimeline([
          wire({
            kind: 'snapshot',
            cursor: state.cursor,
            entries: state.entries,
          }),
        ]),
      ).toEqual({ ...state, snapshotCursor: state.cursor })
    },
  )

  it('does not start or accept a root turn from child user text', () => {
    const state = foldTimeline(frames(lateItems.slice(0, 2)))
    expect(state.activeTurnId).toBeNull()
    expect(
      state.runs.get(timelineRunKey('runtime-1', 'root-run'))?.turns.size,
    ).toBe(0)
    expect(state.events).toEqual(lateItems.slice(0, 2))
  })

  it('keeps native request cancellation separate from turn settlement and permission grants', () => {
    const requests = lateItems.filter((item) =>
      [
        'permission_requested',
        'question_requested',
        'request_cancelled',
      ].includes(item.type),
    )
    const state = foldTimeline(frames([start, ...requests]))
    expect(state.terminal).toBeNull()
    expect(
      state.runs
        .get(timelineRunKey('runtime-1', 'root-run'))
        ?.turns.get('root-turn'),
    ).toEqual({ phase: 'running' })
    expect(state.events).toEqual([start, ...requests])
    for (const item of state.events.filter(
      (item) => item.type === 'request_cancelled',
    )) {
      expect(item).toMatchObject({ ...root, childId: 'child-b' })
      expect(item).not.toHaveProperty('grant')
      expect(item).not.toHaveProperty('outcome')
    }
  })

  it('rejects stale child generations while deduplicating delivery IDs within each generation', () => {
    const current = { ...childUpdate, runtimeGeneration: 'runtime-2' }
    const stale = { ...childUpdate, deliveryId: 'stale-child-update' }
    const state = foldTimeline(frames([...history, current, current, stale]))
    expect(state.events).toEqual([...history, current])
    expect(state.activeGeneration).toBe('runtime-2')
    expect(state.entries.at(-1)?.event).toEqual(stale)
    expect(
      foldTimeline([
        wire({
          kind: 'snapshot',
          cursor: state.cursor,
          entries: state.entries,
        }),
      ]),
    ).toEqual({ ...state, snapshotCursor: state.cursor })
  })

  it('rejects conflicting late metadata and malformed child payloads, including stale frames', () => {
    const state = foldTimeline(frames(history))
    const changed = {
      ...childUpdate,
      providerChildId: 'different-native-agent',
    }
    expect(() =>
      reduceTimeline(state, {
        kind: 'delta',
        cursor: state.cursor,
        event: changed,
      }),
    ).toThrow('Conflicting events')
    expect(() =>
      reduceTimeline(state, snapshot([...history.slice(0, -1), changed])),
    ).toThrow('Conflicting events')
    for (const invalid of [
      { ...childUpdate, childId: '' },
      { ...childUpdate, providerChildId: null },
      { ...childUpdate, status: 'running' },
      { ...childUpdate, outcome: { status: 'completed' } },
      { ...lateItems[0], role: 'system' },
      { ...lateItems[12], requestId: '' },
    ]) {
      expect(() =>
        reduceTimeline(state, {
          kind: 'delta',
          cursor: 1,
          event: invalid as HarnessEvent,
        }),
      ).toThrow()
      expect(() =>
        reduceTimeline(state, snapshot([invalid as HarnessEvent])),
      ).toThrow()
    }
  })
})
