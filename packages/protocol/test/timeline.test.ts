import { describe, expect, it } from 'vitest'
import { harnessEventSchema, type HarnessEvent } from '../src/harness.js'
import {
  foldTimeline,
  reduceTimeline,
  emptyTimeline,
  timelineRunKey,
} from '../src/timeline.js'

const event = (
  type: string,
  runId: string,
  deliveryId: string,
  generation = 'g1',
  turnId = 't1',
) =>
  harnessEventSchema.parse({
    type,
    runId,
    deliveryId,
    runtimeGeneration: generation,
    turnId,
    ...(type === 'turn_completed' ? { outcome: { status: 'completed' } } : {}),
    ...(type === 'run_failed' ? { code: 'E_FAIL', message: 'failed' } : {}),
  })
const start = event('turn_started', 'run-1', 'start', 'g', 'turn-1')
const done = event('turn_completed', 'run-1', 'done', 'g', 'turn-1')
const snapshot = (cursor: number, events: HarnessEvent[]) => ({
  kind: 'snapshot' as const,
  cursor,
  entries: events.map((event, i) => ({ cursor: i + 1, event })),
})

describe('timeline reducer', () => {
  it('scopes delivery dedupe and ownership to runtime generation', () => {
    const state = foldTimeline([
      {
        kind: 'delta',
        cursor: 1,
        event: event('run_started', 'r1', 'd1', 'g1'),
      },
      {
        kind: 'delta',
        cursor: 2,
        event: event('run_started', 'r2', 'd1', 'g2'),
      },
      {
        kind: 'delta',
        cursor: 3,
        event: event('run_started', 'r1', 'late', 'g1'),
      },
    ])
    expect(state.events).toHaveLength(2)
    expect(state.activeRunId).toBe('r2')
  })

  it('restores an older snapshot before the live suffix', () => {
    const old = [
      event('run_started', 'r1', 'd1'),
      event('run_failed', 'r1', 'f1'),
    ]
    const current = event('run_started', 'r2', 'd2', 'g2')
    const state = foldTimeline([
      { kind: 'delta', cursor: 3, event: current },
      snapshot(2, old),
    ])
    expect(state.events).toEqual([...old, current])
    expect(state.runs.get(timelineRunKey('g1', 'r1'))?.failure?.status).toBe(
      'failed',
    )
    expect(state.activeRunId).toBe('r2')
    expect(state.terminal).toBeNull()
  })

  it('does not let an older turn settle a failed run', () => {
    const state = foldTimeline([
      { kind: 'delta', cursor: 1, event: event('run_started', 'r1', 's') },
      { kind: 'delta', cursor: 2, event: event('run_failed', 'r1', 'f') },
      {
        kind: 'delta',
        cursor: 3,
        event: event('turn_completed', 'r1', 'done'),
      },
    ])
    expect(state.terminal).toBe('failed')
  })

  it('clears completion when a later turn starts in the same run', () => {
    const state = foldTimeline([
      { kind: 'delta', cursor: 1, event: event('run_started', 'r1', 's') },
      {
        kind: 'delta',
        cursor: 2,
        event: event('turn_started', 'r1', 't1', 'g1', 't1'),
      },
      {
        kind: 'delta',
        cursor: 3,
        event: event('turn_completed', 'r1', 'd1', 'g1', 't1'),
      },
      {
        kind: 'delta',
        cursor: 4,
        event: event('turn_started', 'r1', 't2', 'g1', 't2'),
      },
    ])
    expect(state.terminal).toBeNull()
    expect(state.runs.get(timelineRunKey('g1', 'r1'))?.turns.get('t1')).toEqual(
      { phase: 'settled', outcome: { status: 'completed' } },
    )
  })

  it('folds snapshots and deltas in the same order', () => {
    const batch = foldTimeline([
      snapshot(1, [start]),
      { kind: 'delta', cursor: 2, event: done },
    ])
    const incremental = foldTimeline([
      { kind: 'delta', cursor: 1, event: start },
      { kind: 'delta', cursor: 2, event: done },
    ])
    expect(incremental.events).toEqual(batch.events)
    expect(incremental.runs).toEqual(batch.runs)
    expect(incremental.terminal).toBe('completed')
  })

  it('ignores identical duplicate and unknown stale delivery', () => {
    const state = reduceTimeline(emptyTimeline(), {
      kind: 'delta',
      cursor: 2,
      event: done,
    })
    expect(
      reduceTimeline(state, { kind: 'delta', cursor: 2, event: done }),
    ).toBe(state)
    expect(
      reduceTimeline(state, { kind: 'delta', cursor: 1, event: start }),
    ).toBe(state)
  })

  it('settles failure once and keeps later duplicate terminal events out', () => {
    const failed = event('run_failed', 'run-1', 'failure')
    const state = foldTimeline([
      { kind: 'delta', cursor: 1, event: failed },
      { kind: 'delta', cursor: 2, event: failed },
    ])
    expect(state.terminal).toBe('failed')
    expect(state.events).toHaveLength(1)
  })

  it('keeps distinct deliveries for one item and deduplicates only delivery retries', () => {
    const text = (deliveryId: string, text: string) =>
      harnessEventSchema.parse({
        type: 'text_delta',
        runId: 'run-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        deliveryId,
        runtimeGeneration: 'generation-1',
        text,
      })
    const state = foldTimeline([
      { kind: 'delta', cursor: 1, event: text('delivery-1', 'hel') },
      { kind: 'delta', cursor: 2, event: text('delivery-2', 'lo') },
      { kind: 'delta', cursor: 2, event: text('delivery-2', 'lo') },
    ])
    expect(
      state.events.map((event) => ('text' in event ? event.text : '')),
    ).toEqual(['hel', 'lo'])
  })

  it('treats a current snapshot as authoritative after a live race', () => {
    const state = foldTimeline([
      { kind: 'delta', cursor: 2, event: done },
      snapshot(2, [start, done]),
    ])
    expect(state.events).toEqual([start, done])
  })

  it('settles each run independently', () => {
    const state = foldTimeline([
      {
        kind: 'delta',
        cursor: 1,
        event: event('run_started', 'run-1', 'start-1', 'g'),
      },
      {
        kind: 'delta',
        cursor: 2,
        event: event('run_failed', 'run-1', 'fail-1', 'g'),
      },
      {
        kind: 'delta',
        cursor: 3,
        event: event('run_started', 'run-2', 'start-2', 'g'),
      },
    ])
    expect(state.terminal).toBeNull()
    expect(state.runs.get(timelineRunKey('g', 'run-1'))?.failure?.status).toBe(
      'failed',
    )
  })
})
