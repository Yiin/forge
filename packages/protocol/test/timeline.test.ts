import { describe, expect, it } from 'vitest'
import { foldTimeline, reduceTimeline, emptyTimeline } from '../src/timeline.js'

const start = { type: 'turn_started', turnId: 'turn-1' } as const
const done = { type: 'turn_completed', turnId: 'turn-1', stopReason: 'end' } as const

describe('timeline reducer', () => {
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
    const state = reduceTimeline(emptyTimeline(), { kind: 'delta', cursor: 1, event: done })
    expect(reduceTimeline(state, { kind: 'delta', cursor: 1, event: done })).toBe(state)
    expect(reduceTimeline(state, { kind: 'delta', cursor: 0, event: start })).toBe(state)
  })

  it('settles failure once and keeps later duplicate terminal events out', () => {
    const state = foldTimeline([
      { kind: 'delta', cursor: 1, event: { type: 'run_failed', runId: 'run-1', code: 'E_FAIL', message: 'failed' } },
      { kind: 'delta', cursor: 2, event: { type: 'run_failed', runId: 'run-1', code: 'E_FAIL', message: 'failed' } },
    ])
    expect(state.terminal).toBe('failed')
    expect(state.events).toHaveLength(1)
  })
})

