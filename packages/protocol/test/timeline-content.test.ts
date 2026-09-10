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
const start = event('root-started', { type: 'turn_started' })
const done = event('root-completed', {
  type: 'turn_completed',
  outcome: { status: 'completed' },
})
const textIdentity = { itemId: 'text', providerItemId: 'native-text' }
const corrected = event('text-final', {
  type: 'content_snapshot',
  ...textIdentity,
  contentType: 'text',
  text: 'Right.',
  phase: 'final_answer',
  delivery: 'async',
  questions: [{ title: 'Continue?', options: ['Yes', 'No'] }],
})
const metadataCleared = event('text-metadata-cleared', {
  ...corrected,
  deliveryId: 'text-metadata-cleared',
  phase: null,
  delivery: null,
  questions: null,
})
const retry = event('retry-error', {
  type: 'diagnostic',
  itemId: 'diagnostic',
  severity: 'error',
  code: 'responseStreamDisconnected',
  message: 'The stream disconnected',
  retryable: true,
  httpStatus: null,
  details: 'Retrying\u2028the response\u2029stream',
})
const latestUsage = {
  type: 'usage',
  itemId: 'usage',
  inputTokens: 4,
  outputTokens: 3,
  totalTokens: 7,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 2,
  reasoningOutputTokens: 1,
  cumulative: {
    inputTokens: 10,
    outputTokens: 8,
    totalTokens: 18,
    cachedInputTokens: 2,
    cacheWriteInputTokens: 4,
    reasoningOutputTokens: 3,
  },
  modelContextWindow: 1000,
}
const progress = event('progress-explained', {
  type: 'plan',
  itemId: 'progress',
  steps: [{ id: 'inspect', title: 'Inspect source', status: 'running' }],
  explanation: 'Read\u2028before editing',
})
const activeItems = [
  event('text-partial', {
    type: 'text_delta',
    ...textIdentity,
    text: 'The partial answer is wrong.',
  }),
  corrected,
  // The same text with omitted metadata must remain distinguishable from explicit null.
  event('text-metadata-omitted', {
    type: 'content_snapshot',
    ...textIdentity,
    contentType: 'text',
    text: 'Right.',
  }),
  metadataCleared,
  event('thought-partial', {
    type: 'thought_delta',
    itemId: 'thought',
    text: 'A longer partial explanation.',
  }),
  event('thought-final', {
    type: 'content_snapshot',
    itemId: 'thought',
    contentType: 'thought',
    text: 'Check.',
  }),
  event('thought-cleared', {
    type: 'content_snapshot',
    itemId: 'thought',
    contentType: 'thought',
    text: '',
  }),
  event('plan-partial', {
    type: 'content_snapshot',
    itemId: 'proposed-plan',
    contentType: 'plan',
    text: 'A',
  }),
  progress,
  event('plan-final', {
    type: 'content_snapshot',
    itemId: 'proposed-plan',
    contentType: 'plan',
    text: 'B',
  }),
  event('progress-unexplained', {
    type: 'plan',
    itemId: 'progress',
    steps: [],
  }),
  event('progress-explanation-cleared', {
    type: 'plan',
    itemId: 'progress',
    steps: [],
    explanation: null,
  }),
  event('final-only', {
    type: 'content_snapshot',
    itemId: 'final-only',
    contentType: 'text',
    text: 'Only\u2028a final\u2029answer.',
  }),
  retry,
  event('info', {
    type: 'diagnostic',
    itemId: 'diagnostic',
    code: 'retryStarted',
    message: 'Retry started',
    severity: 'info',
  }),
  event('warning', {
    type: 'diagnostic',
    itemId: 'diagnostic',
    code: 'slowResponse',
    message: 'Waiting for a response',
    severity: 'warning',
  }),
  event('nonretryable-error', {
    type: 'diagnostic',
    itemId: 'diagnostic',
    code: 'misalignmentPolicyViolation',
    message: 'Continuation requires a user choice',
    severity: 'error',
    retryable: false,
    httpStatus: 0,
    details: 'Submit the next user turn only if continuation is selected.',
  }),
  event('usage-1', latestUsage),
  event('usage-2', latestUsage),
]
const childStart = event('child-started', {
  type: 'child_started',
  itemId: 'child',
  childId: 'child-1',
  parentToolCallId: 'spawning-tool',
  description: 'Inspect source',
})
const childPartial = event('child-text-partial', {
  type: 'text_delta',
  ...textIdentity,
  childId: 'child-1',
  role: 'user',
  text: 'Inspect the entire source tree.',
})
const lateChildItems = [
  event('child-text-final', {
    type: 'content_snapshot',
    ...textIdentity,
    childId: 'child-1',
    role: 'user',
    contentType: 'text',
    text: 'Inspect source.',
    questions: null,
  }),
  event('child-thought-final', {
    type: 'content_snapshot',
    itemId: 'thought',
    childId: 'child-1',
    contentType: 'thought',
    text: 'Read the parser.',
  }),
  event('child-plan-final', {
    type: 'content_snapshot',
    itemId: 'proposed-plan',
    childId: 'child-1',
    contentType: 'plan',
    text: 'Test the parser.',
  }),
  event('child-error', {
    type: 'diagnostic',
    itemId: 'diagnostic',
    childId: 'child-1',
    code: 'childTaskFailed',
    message: 'The child task failed',
    severity: 'error',
    retryable: false,
    httpStatus: 65535,
    details: null,
  }),
  event('child-usage', {
    ...latestUsage,
    childId: 'child-1',
    inputTokens: 2,
    outputTokens: 1,
    totalTokens: 3,
    cumulative: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    modelContextWindow: null,
  }),
]
const childDone = event('child-finished', {
  type: 'child_finished',
  childId: 'child-1',
  itemId: 'child',
  outcome: {
    status: 'failed',
    code: 'E_CHILD',
    message: 'The child task failed',
  },
})
const history = [
  start,
  ...activeItems,
  childStart,
  childPartial,
  done,
  ...lateChildItems,
  childDone,
]
const deltas = (events: HarnessEvent[]) =>
  events.map((event, i) => ({ kind: 'delta' as const, cursor: i + 1, event }))
const snapshot = (
  events: HarnessEvent[],
  cursor = events.length,
): TimelineFrame => ({
  kind: 'snapshot',
  cursor,
  entries: deltas(events).map(({ cursor, event }) => ({ cursor, event })),
})
const wire = (frame: TimelineFrame) =>
  timelineFrameSchema.parse(JSON.parse(JSON.stringify(frame)))
const append = (state: ReturnType<typeof foldTimeline>, item: HarnessEvent) =>
  reduceTimeline(
    state,
    wire({ kind: 'delta', cursor: state.cursor + 1, event: item }),
  )

// These assertions prove retained payloads and lifecycle state. Display replacement belongs to .23.
describe('content, diagnostic, and usage timeline retention', () => {
  it('retains corrections and diagnostics without settling an established root turn', () => {
    let state = foldTimeline(deltas([start]).map(wire))
    const runs = state.runs
    for (const item of activeItems) {
      state = append(state, item)
      expect(state.runs).toBe(runs)
      expect(state.activeRunId).toBe(root.runId)
      expect(state.activeTurnId).toBe(root.turnId)
      expect(state.terminal).toBeNull()
    }
    expect(state.events).toStrictEqual([start, ...activeItems])
    expect(state.entries.map(({ event }) => event)).toStrictEqual(state.events)
    expect(
      state.runs.get(timelineRunKey(root.runtimeGeneration, root.runId))?.turns,
    ).toEqual(new Map([[root.turnId, { phase: 'running' }]]))
    state = append(state, done)
    expect(state.terminal).toBe('completed')
    expect(state.events).toContainEqual(retry)
    expect(state.events.at(-1)).toStrictEqual(done)
  })

  it('retains shorter, empty, final-only, and metadata-only snapshots under stable item identities', () => {
    const state = foldTimeline(deltas(history).map(wire))
    const rootItems = state.events.filter((item) => !('childId' in item))
    const content = (itemId: string) =>
      rootItems.filter(
        (item) => 'itemId' in item && item.itemId === itemId && 'text' in item,
      )
    expect(
      content('text').map((item) => 'text' in item && item.text),
    ).toStrictEqual([
      'The partial answer is wrong.',
      'Right.',
      'Right.',
      'Right.',
    ])
    expect(
      content('text').map(
        (item) => 'providerItemId' in item && item.providerItemId,
      ),
    ).toStrictEqual(Array(4).fill('native-text'))
    expect(content('text')[1]).toHaveProperty('questions', [
      { title: 'Continue?', options: ['Yes', 'No'] },
    ])
    expect(content('text')[2]).not.toHaveProperty('questions')
    expect(content('text')[3]).toHaveProperty('questions', null)
    expect(
      content('thought').map((item) => 'text' in item && item.text),
    ).toStrictEqual(['A longer partial explanation.', 'Check.', ''])
    expect(
      content('proposed-plan').map((item) => 'text' in item && item.text),
    ).toStrictEqual(['A', 'B'])
    expect(content('final-only')).toHaveLength(1)
    expect(content('final-only')[0]).toHaveProperty('type', 'content_snapshot')
    const progressEvents = rootItems.filter((item) => item.type === 'plan')
    expect(progressEvents.map((item) => item.itemId)).toStrictEqual(
      Array(3).fill('progress'),
    )
    expect(progressEvents[0]).toHaveProperty(
      'explanation',
      'Read\u2028before editing',
    )
    expect(progressEvents[1]).not.toHaveProperty('explanation')
    expect(progressEvents[2]).toHaveProperty('explanation', null)
    expect(
      state.events.filter((item) => item.type === 'question_requested'),
    ).toEqual([])
    expect(state.terminal).toBe('completed')
  })

  it('retains repeated cumulative values without adding them or mixing child usage', () => {
    const state = foldTimeline(deltas(history).map(wire))
    const usage = state.events.filter((item) => item.type === 'usage')
    expect(usage.map((item) => item.totalTokens)).toStrictEqual([7, 7, 3])
    expect(usage.map((item) => item.cumulative?.totalTokens)).toStrictEqual([
      18, 18, 3,
    ])
    expect(usage.map((item) => item.modelContextWindow)).toStrictEqual([
      1000,
      1000,
      null,
    ])
    expect(
      usage.slice(0, 2).map((item) => item.cachedInputTokens),
    ).toStrictEqual([0, 0])
    expect(usage[2]).toHaveProperty('childId', 'child-1')
    expect(state.terminal).toBe('completed')
  })

  it('retains every payload and outcome across every snapshot and live boundary', () => {
    const expected = foldTimeline(deltas(history).map(wire))
    expect(expected.events).toStrictEqual(history)
    for (let cut = 0; cut <= history.length; cut++) {
      const prefix = wire(snapshot(history.slice(0, cut)))
      const suffix = deltas(history).slice(cut).map(wire)
      expect(foldTimeline([prefix, ...suffix])).toEqual({
        ...expected,
        snapshotCursor: cut,
      })
      expect(foldTimeline([...suffix, prefix])).toEqual({
        ...expected,
        snapshotCursor: cut,
      })
      expect(foldTimeline([...deltas(history).map(wire), prefix])).toEqual({
        ...expected,
        snapshotCursor: cut,
      })
    }
  })

  it('keeps the completed root settled through late child content, errors, usage, and completion', () => {
    let state = foldTimeline(
      deltas([start, childStart, childPartial, done]).map(wire),
    )
    const runs = state.runs
    for (const item of [...lateChildItems, childDone]) {
      state = append(state, item)
      expect(state.runs).toBe(runs)
      expect(state.terminal).toBe('completed')
      expect(state.activeRunId).toBe(root.runId)
      expect(state.activeTurnId).toBe(root.turnId)
      expect(state.events.at(-1)).toMatchObject({ ...root, childId: 'child-1' })
    }
    expect(state.events.slice(4)).toStrictEqual([...lateChildItems, childDone])
    expect(
      state.events.filter((item) => item.type === 'child_finished'),
    ).toEqual([childDone])
  })

  it.each(['same run', 'new run'])(
    'keeps late child content on its spawning turn during a later active root turn in the %s',
    (mode) => {
      const later = {
        runId: mode === 'same run' ? root.runId : 'later-run',
        turnId: 'later-turn',
      }
      let state = foldTimeline(
        deltas([
          start,
          childStart,
          childPartial,
          done,
          event('later-started', { type: 'turn_started', ...later }),
        ]).map(wire),
      )
      const runs = state.runs
      for (const item of [...lateChildItems, childDone]) {
        state = append(state, item)
        expect(state.runs).toBe(runs)
        expect(state.activeRunId).toBe(later.runId)
        expect(state.activeTurnId).toBe(later.turnId)
        expect(state.terminal).toBeNull()
      }
      expect(
        state.runs
          .get(timelineRunKey(root.runtimeGeneration, root.runId))
          ?.turns.get(root.turnId),
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

  it.each([
    { status: 'completed' },
    { status: 'interrupted', reason: 'User cancelled' },
    { status: 'failed', code: 'E_TURN', message: 'The turn failed' },
  ])(
    'does not change an established %j outcome with later nonterminal events',
    (outcome) => {
      let state = foldTimeline(
        deltas([
          start,
          event('settled', { type: 'turn_completed', outcome }),
        ]).map(wire),
      )
      const runs = state.runs
      for (const item of activeItems) {
        state = append(state, item)
        expect(state.runs).toBe(runs)
        expect(state.terminal).toBe(outcome.status)
      }
    },
  )

  it('deduplicates delivery retries while retaining distinct corrections and repeated usage', () => {
    let state = foldTimeline(deltas(history).map(wire))
    for (const item of [
      corrected,
      metadataCleared,
      retry,
      ...activeItems.slice(-2),
    ]) {
      const before = state
      state = append(state, item)
      expect(state.events).toBe(before.events)
      expect(state.runs).toBe(before.runs)
      expect(state.entries.at(-1)?.event).toStrictEqual(item)
      expect(
        reduceTimeline(
          state,
          wire({ kind: 'delta', cursor: state.cursor, event: item }),
        ),
      ).toBe(state)
    }
    expect(state.events).toStrictEqual(history)
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

  it('retains stale generation entries without admitting their payloads or changing current ownership', () => {
    const currentStart = event('current-start', {
      type: 'turn_started',
      runtimeGeneration: 'runtime-2',
      runId: 'current-run',
      turnId: 'current-turn',
    })
    const currentContent = event(corrected.deliveryId, {
      ...corrected,
      runtimeGeneration: 'runtime-2',
      runId: 'current-run',
      turnId: 'current-turn',
    })
    const accepted = [...history, currentStart, currentContent]
    let state = foldTimeline(deltas(accepted).map(wire))
    for (const item of [
      corrected,
      retry,
      activeItems.at(-1)!,
      ...lateChildItems,
    ]) {
      const stale = { ...item, deliveryId: `stale-${item.deliveryId}` }
      const before = state
      state = append(state, stale)
      expect(state.events).toBe(before.events)
      expect(state.runs).toBe(before.runs)
      expect(state.entries.at(-1)?.event).toStrictEqual(stale)
    }
    expect(state.events).toStrictEqual(accepted)
    expect(state.activeGeneration).toBe('runtime-2')
    expect(state.activeRunId).toBe('current-run')
    expect(state.activeTurnId).toBe('current-turn')
    expect(state.terminal).toBeNull()
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

  it('recovers rejected content, diagnostics, and usage after a prefix restores generation order', () => {
    const otherStart = event('other-start', {
      type: 'turn_started',
      runtimeGeneration: 'runtime-2',
      runId: 'other-run',
      turnId: 'other-turn',
    })
    const suffix = [corrected, retry, activeItems.at(-1)!, done].map(
      (event, i) => ({
        kind: 'delta' as const,
        cursor: 30 + i,
        event,
      }),
    )
    const live = foldTimeline(
      [
        { kind: 'delta' as const, cursor: 10, event: start },
        { kind: 'delta' as const, cursor: 20, event: otherStart },
        ...suffix,
      ].map(wire),
    )
    expect(live.events).toStrictEqual([start, otherStart])
    expect(live.entries.slice(-4).map(({ event }) => event)).toStrictEqual(
      suffix.map(({ event }) => event),
    )
    const prefix = wire({
      kind: 'snapshot',
      cursor: 15,
      entries: [
        { cursor: 5, event: otherStart },
        { cursor: 10, event: start },
      ],
    })
    const recovered = reduceTimeline(live, prefix)
    expect(recovered.events).toStrictEqual([
      otherStart,
      start,
      ...suffix.map(({ event }) => event),
    ])
    expect(recovered.entries.map(({ cursor }) => cursor)).toStrictEqual([
      5, 10, 20, 30, 31, 32, 33,
    ])
    expect(recovered.activeGeneration).toBe(root.runtimeGeneration)
    expect(recovered.activeRunId).toBe(root.runId)
    expect(recovered.terminal).toBe('completed')
    expect(
      foldTimeline([
        wire({
          kind: 'snapshot',
          cursor: recovered.cursor,
          entries: recovered.entries,
        }),
      ]),
    ).toEqual({ ...recovered, snapshotCursor: recovered.cursor })
  })

  it.each([
    [corrected, { text: 'Different final text' }],
    [corrected, { questions: null }],
    [retry, { retryable: false }],
    [
      activeItems.at(-1)!,
      { cumulative: { inputTokens: 20, outputTokens: 8, totalTokens: 28 } },
    ],
    [progress, { explanation: null }],
  ])(
    'rejects conflicting payloads at one cursor for %j',
    (original, fields) => {
      const known = original as HarnessEvent
      const state = foldTimeline(deltas([start, known]).map(wire))
      const changed = harnessEventSchema.parse({ ...known, ...fields })
      expect(() =>
        reduceTimeline(state, { kind: 'delta', cursor: 2, event: changed }),
      ).toThrow('Conflicting events at one timeline cursor')
      expect(() => reduceTimeline(state, snapshot([start, changed]))).toThrow(
        'Conflicting events at one timeline cursor',
      )
    },
  )

  it('validates malformed stale frames before cursor admission', () => {
    const state = foldTimeline([wire(snapshot(history))])
    for (const invalid of [
      { ...corrected, contentType: 'thought' },
      {
        ...corrected,
        questions: [{ title: '', requestId: 'invented-request' }],
      },
      { ...retry, details: { raw: 'error' } },
      { ...activeItems.at(-1)!, totalTokens: Number.MAX_SAFE_INTEGER + 1 },
      { ...progress, explanation: 42 },
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
