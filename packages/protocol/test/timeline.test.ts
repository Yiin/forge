import { describe, expect, it } from 'vitest'
import { foldTimeline, reduceTimeline, emptyTimeline } from '../src/timeline.js'

const start = { type: 'turn_started', turnId: 'turn-1' } as const
const done = {
  type: 'turn_completed',
  turnId: 'turn-1',
  stopReason: 'end',
} as const

describe('timeline reducer', () => {
  const event = (
    type: 'run_started' | 'turn_started' | 'turn_completed' | 'run_failed',
    runId: string,
    deliveryId: string,
    generation = 'g1',
    turnId = 't1',
  ) => {
    if (type === 'run_started')
      return { type, runId, deliveryId, runtimeGeneration: generation } as const
    if (type === 'run_failed')
      return {
        type,
        runId,
        deliveryId,
        runtimeGeneration: generation,
        code: 'E_FAIL',
        message: 'failed',
      } as const
    return {
      type,
      runId,
      turnId,
      deliveryId,
      runtimeGeneration: generation,
    } as const
  }

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

  it('ignores an older snapshot and rebuilds derived state from a current snapshot', () => {
    const state = foldTimeline([
      {
        kind: 'delta',
        cursor: 3,
        event: event('run_started', 'r2', 'd2', 'g2'),
      },
      {
        kind: 'snapshot',
        cursor: 2,
        events: [
          event('run_started', 'r1', 'd1'),
          event('run_failed', 'r1', 'f1'),
        ],
      },
    ])
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
    expect(state.completedTurns).toEqual(new Set(['t1']))
  })
  it('folds snapshots and deltas in the same order', () => {
    const batch = foldTimeline([
      { kind: 'snapshot', cursor: 1, events: [start] },
      { kind: 'delta', cursor: 2, event: done },
    ])
    const incremental = foldTimeline([
      { kind: 'delta', cursor: 1, event: start },
      { kind: 'delta', cursor: 2, event: done },
    ])
    expect(incremental.events).toEqual(batch.events)
    expect([...incremental.completedTurns]).toEqual(['turn-1'])
    expect(incremental.terminal).toBe('completed')
  })

  it('ignores duplicate and stale delivery', () => {
    const state = reduceTimeline(emptyTimeline(), {
      kind: 'delta',
      cursor: 1,
      event: done,
    })
    expect(
      reduceTimeline(state, { kind: 'delta', cursor: 1, event: done }),
    ).toBe(state)
    expect(
      reduceTimeline(state, { kind: 'delta', cursor: 0, event: start }),
    ).toBe(state)
  })

  it('settles failure once and keeps later duplicate terminal events out', () => {
    const state = foldTimeline([
      {
        kind: 'delta',
        cursor: 1,
        event: {
          type: 'run_failed',
          runId: 'run-1',
          code: 'E_FAIL',
          message: 'failed',
        },
      },
      {
        kind: 'delta',
        cursor: 2,
        event: {
          type: 'run_failed',
          runId: 'run-1',
          code: 'E_FAIL',
          message: 'failed',
        },
      },
    ])
    expect(state.terminal).toBe('failed')
    expect(state.events).toHaveLength(1)
  })

  it('keeps distinct deliveries for one item and deduplicates only delivery retries', () => {
    const text = (deliveryId: string, value: string) => ({
      type: 'text_delta' as const,
      runId: 'run-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      deliveryId,
      runtimeGeneration: 'generation-1',
      text: value,
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
      {
        kind: 'delta',
        cursor: 2,
        event: { ...done, deliveryId: 'done', runtimeGeneration: 'g' },
      },
      {
        kind: 'snapshot',
        cursor: 2,
        events: [
          { ...start, deliveryId: 'start', runtimeGeneration: 'g' },
          { ...done, deliveryId: 'done', runtimeGeneration: 'g' },
        ],
      },
    ])
    expect(state.events.map((event) => event.type)).toEqual([
      'turn_started',
      'turn_completed',
    ])
  })

  it('settles each run independently', () => {
    const event = (
      runId: string,
      deliveryId: string,
      type: 'run_started' | 'run_failed',
    ) =>
      type === 'run_started'
        ? ({ type, runId, deliveryId, runtimeGeneration: 'g' } as const)
        : ({
            type,
            runId,
            deliveryId,
            runtimeGeneration: 'g',
            code: 'E_FAIL',
            message: 'failed',
          } as const)
    const state = foldTimeline([
      {
        kind: 'delta',
        cursor: 1,
        event: event('run-1', 'start-1', 'run_started'),
      },
      {
        kind: 'delta',
        cursor: 2,
        event: event('run-1', 'fail-1', 'run_failed'),
      },
      {
        kind: 'delta',
        cursor: 3,
        event: event('run-2', 'start-2', 'run_started'),
      },
    ])
    expect(state.terminal).toBeNull()
    expect(state.terminalByRun.get('run-1')).toBe('failed')
  })
})
