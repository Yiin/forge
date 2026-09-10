import { describe, expect, it } from 'vitest'
import { harnessEventSchema, type HarnessEvent } from '../src/harness.js'
import {
  emptyTimeline,
  foldTimeline,
  reduceTimeline,
  timelineRunKey,
} from '../src/timeline.js'

const event = (type: string, fields: Record<string, unknown> = {}) =>
  harnessEventSchema.parse({
    type,
    runId: 'r',
    runtimeGeneration: 'g',
    deliveryId: type,
    ...fields,
  })
const start = (turnId: string) =>
  event('turn_started', { turnId, deliveryId: `start-${turnId}` })
const accept = (turnId: string, type = 'prompt_accepted') =>
  event(type, {
    turnId,
    receiptId: `receipt-${turnId}`,
    deliveryId: `accept-${turnId}`,
  })
const done = (turnId: string, status = 'completed') =>
  event('turn_completed', {
    turnId,
    deliveryId: `done-${turnId}-${status}`,
    outcome:
      status === 'failed'
        ? { status, code: 'E_TURN', message: 'turn failed' }
        : { status },
  })
const fail = event('run_failed', { code: 'E_RUN', message: 'runtime failed' })
const deltas = (events: HarnessEvent[]) =>
  events.map((event, i) => ({ kind: 'delta' as const, cursor: i + 1, event }))

const history = [event('run_started'), start('t1'), done('t1')]

describe('timeline lifecycle acceptance', () => {
  it('records a later run failure after a successful earlier turn', () => {
    const state = foldTimeline(deltas([...history, start('t2'), fail]))
    expect(state.terminal).toBe('failed')
  })

  it.each(['prompt_accepted', 'steer_accepted'])(
    'keeps newer %s work unsettled before it starts',
    (type) => {
      const state = foldTimeline(
        deltas([...history, accept('t2', type), done('t1', 'interrupted')]),
      )
      expect(state.terminal).toBeNull()
    },
  )

  it.each(['interrupted', 'failed'])(
    'preserves a turn outcome of %s',
    (status) => {
      const state = foldTimeline(
        deltas([event('run_started'), start('t'), done('t', status)]),
      )
      expect(state.terminal).toBe(status)
    },
  )

  it('does not let delayed earlier completions settle a newer started turn', () => {
    const state = foldTimeline(
      deltas([...history, start('t2'), done('t1', 'failed')]),
    )
    expect(state.terminal).toBeNull()
    expect(state.activeTurnId).toBe('t2')
  })

  it('keeps the first outcome for one turn across conflicting later deliveries', () => {
    const state = foldTimeline(
      deltas([
        event('run_started'),
        start('t'),
        done('t', 'interrupted'),
        done('t'),
      ]),
    )
    expect(state.terminal).toBe('interrupted')
  })

  it('preserves failure after late starts, acceptance, and completion', () => {
    const state = foldTimeline(
      deltas([
        ...history,
        start('t2'),
        fail,
        accept('t3'),
        start('t3'),
        done('t3'),
      ]),
    )
    expect(state.terminal).toBe('failed')
  })

  it('does not treat a steer into the running turn as a new pending turn', () => {
    const state = foldTimeline(
      deltas([
        event('run_started'),
        start('t'),
        accept('t', 'steer_accepted'),
        done('t'),
      ]),
    )
    expect(state.terminal).toBe('completed')
  })

  it('keeps distinct generation/delivery tuples despite embedded colons', () => {
    const state = foldTimeline(
      deltas([
        event('run_started', { runtimeGeneration: 'g:a', deliveryId: 'b' }),
        event('run_started', {
          runId: 'r2',
          runtimeGeneration: 'g',
          deliveryId: 'a:b',
        }),
      ]),
    )
    expect(state.events).toHaveLength(2)
    expect(state.activeRunId).toBe('r2')
  })

  it('advances duplicate delivery watermarks without replacing event or lifecycle references', () => {
    const state = foldTimeline(deltas(history))
    const duplicate = reduceTimeline(state, {
      kind: 'delta',
      cursor: 4,
      event: history[2],
    })
    expect(duplicate.cursor).toBe(4)
    expect(duplicate.events).toBe(state.events)
    for (const key of Object.keys(state) as (keyof typeof state)[]) {
      if (key !== 'entries' && typeof state[key] === 'object')
        expect(duplicate[key]).toBe(state[key])
    }
  })

  it('does not rescan retained lifecycle history for each text delta', () => {
    const typeReads = (count: number) => {
      let reads = 0
      let state = emptyTimeline()
      for (let i = 0; i < count; i++) {
        state = reduceTimeline(state, {
          kind: 'delta',
          cursor: i + 1,
          event: event('text_delta', {
            turnId: 't',
            itemId: 'item',
            text: 'x',
            deliveryId: `d${i}`,
          }),
        })
        const watched = new Proxy(state.events.at(-1)!, {
          get(target, key, receiver) {
            if (key === 'type') reads++
            return Reflect.get(target, key, receiver)
          },
        })
        // Watch retained history, not the input that Zod clones on validation.
        state = {
          ...state,
          events: [...state.events.slice(0, -1), watched],
          entries: [
            ...state.entries.slice(0, -1),
            { cursor: i + 1, event: watched },
          ],
        }
      }
      expect(state.events).toHaveLength(count)
      return reads
    }
    expect(typeReads(100)).toBe(0)
    expect(typeReads(200)).toBe(0)
  })

  it('preserves unrelated run and turn references when another turn changes', () => {
    const state = foldTimeline(deltas(history))
    const oldRun = state.runs.get(timelineRunKey('g', 'r'))!
    const changed = reduceTimeline(state, {
      kind: 'delta',
      cursor: 4,
      event: accept('t2'),
    })
    const run = changed.runs.get(timelineRunKey('g', 'r'))!
    expect(run.turns.get('t1')).toBe(oldRun.turns.get('t1'))
    expect(run.turns.get('t2')).toEqual({ phase: 'accepted' })
    const text = reduceTimeline(changed, {
      kind: 'delta',
      cursor: 5,
      event: event('text_delta', {
        turnId: 't2',
        itemId: 'i',
        text: 'x',
        deliveryId: 'text',
      }),
    })
    expect(text.runs).toBe(changed.runs)
    expect(text.generations).toBe(changed.generations)
  })

  it('keeps every settled turn outcome when a later turn fails', () => {
    const state = foldTimeline(
      deltas([...history, accept('t2'), start('t2'), fail]),
    )
    const run = state.runs.get(timelineRunKey('g', 'r'))!
    expect(run.turns.get('t1')).toEqual({
      phase: 'settled',
      outcome: { status: 'completed' },
    })
    expect(run.turns.get('t2')).toEqual({
      phase: 'settled',
      outcome: { status: 'failed', code: 'E_RUN', message: 'runtime failed' },
    })
    expect(run.failure).toEqual({
      status: 'failed',
      code: 'E_RUN',
      message: 'runtime failed',
    })
  })

  it('keeps several accepted turns pending until each settles', () => {
    const state = foldTimeline(
      deltas([...history, accept('t2'), accept('t3'), start('t2'), done('t2')]),
    )
    expect(state.terminal).toBeNull()
    expect(state.runs.get(timelineRunKey('g', 'r'))?.turns.get('t3')).toEqual({
      phase: 'accepted',
    })
    const settled = reduceTimeline(state, {
      kind: 'delta',
      cursor: 8,
      event: done('t3', 'interrupted'),
    })
    expect(settled.terminal).toBe('interrupted')
  })

  it('keeps run and turn state separate across runtime generations', () => {
    const restarted = event('run_started', {
      runtimeGeneration: 'g2',
      deliveryId: 'restarted',
    })
    const state = foldTimeline(deltas([...history, fail, restarted]))
    expect(state.terminal).toBeNull()
    expect(state.runs.get(timelineRunKey('g2', 'r'))?.failure).toBeNull()
    expect(state.runs.get(timelineRunKey('g', 'r'))?.failure?.status).toBe(
      'failed',
    )
  })

  it('rejects malformed frames at the reducer boundary', () => {
    expect(() =>
      reduceTimeline(emptyTimeline(), {
        kind: 'delta',
        cursor: 1,
        event: { type: 'run_started', runId: 42 },
      } as never),
    ).toThrow()
  })
})

const snapshot = (
  cursor: number,
  events: HarnessEvent[],
  cursors = events.map((_, i) => i + 1),
) => ({
  kind: 'snapshot' as const,
  cursor,
  entries: events.map((event, i) => ({ cursor: cursors[i], event })),
})

describe('ordered snapshot acceptance', () => {
  it('merges a delayed complete snapshot with the later live suffix', () => {
    const nextRun = event('run_started', {
      runId: 'r2',
      runtimeGeneration: 'g2',
      deliveryId: 'r2',
    })
    const all = [...history, nextRun]
    const ordered = foldTimeline([snapshot(20, all, [2, 5, 10, 20])])
    const raced = foldTimeline([
      { kind: 'delta', cursor: 20, event: nextRun },
      snapshot(10, history, [2, 5, 10]),
    ])
    expect(raced.events).toEqual(ordered.events)
    expect(raced.runs).toEqual(ordered.runs)
    expect(raced.activeRunId).toBe(ordered.activeRunId)
    expect(raced.terminal).toBe(ordered.terminal)
    expect(raced.entries).toEqual(ordered.entries)
  })

  it('applies identical deduplication and generation rules to snapshots and deltas', () => {
    const events = [
      event('run_started'),
      event('run_started', {
        runId: 'r2',
        runtimeGeneration: 'g2',
        deliveryId: 'r2',
      }),
      event('run_started', { deliveryId: 'late' }),
    ]
    events.push(events[1])
    const live = foldTimeline(deltas(events))
    const batch = foldTimeline([snapshot(4, events)])
    expect(batch.events).toEqual(live.events)
    expect(batch.runs).toEqual(live.runs)
    expect(batch.events).toHaveLength(2)
    expect(batch.activeRunId).toBe('r2')
  })

  it('recovers a rejected suffix when the earlier snapshot changes generation order', () => {
    const g1 = event('run_started', { deliveryId: 'g1' })
    const g2 = event('run_started', {
      runtimeGeneration: 'g2',
      runId: 'r2',
      deliveryId: 'g2',
    })
    const text = event('text_delta', {
      turnId: 't',
      itemId: 'i',
      text: 'recovered',
      deliveryId: 'text',
    })
    const live = foldTimeline([
      { kind: 'delta', cursor: 10, event: g1 },
      { kind: 'delta', cursor: 20, event: g2 },
      { kind: 'delta', cursor: 30, event: text },
    ])
    expect(live.events).not.toContainEqual(text)
    const recovered = reduceTimeline(live, snapshot(15, [g2, g1], [5, 10]))
    const clean = foldTimeline([
      snapshot(30, [g2, g1, g2, text], [5, 10, 20, 30]),
    ])
    expect(recovered.events).toEqual([g2, g1, text])
    expect(recovered.events).toEqual(clean.events)
    expect(recovered.runs).toEqual(clean.runs)
    expect(recovered.cursor).toBe(30)
  })

  it('keeps live settlement above the snapshot watermark', () => {
    const finish = done('t', 'interrupted')
    const state = foldTimeline([
      { kind: 'delta', cursor: 10, event: finish },
      snapshot(5, [event('run_started'), start('t')], [1, 5]),
    ])
    expect(state.terminal).toBe('interrupted')
    expect(state.events).toEqual([event('run_started'), start('t'), finish])
  })

  it('replaces equal-watermark prefixes, retains live suffixes, and ignores older complete snapshots', () => {
    const s = event('run_started')
    const text = event('text_delta', {
      turnId: 't',
      itemId: 'i',
      text: 'x',
      deliveryId: 'text',
    })
    const live = foldTimeline([
      snapshot(5, [s], [2]),
      { kind: 'delta', cursor: 10, event: text },
    ])
    const replaced = reduceTimeline(live, snapshot(5, []))
    expect(replaced.events).toEqual([text])
    expect(replaced.cursor).toBe(10)
    expect(replaced.snapshotCursor).toBe(5)
    expect(reduceTimeline(replaced, snapshot(4, [s], [2]))).toBe(replaced)
  })

  it('clears removed lifecycle records in a current complete snapshot', () => {
    const before = foldTimeline(deltas([...history, fail]))
    const replacement = event('run_started', {
      runId: 'replacement',
      runtimeGeneration: 'g2',
      deliveryId: 'new',
    })
    const after = reduceTimeline(before, snapshot(20, [replacement], [20]))
    expect(after.events).toEqual([replacement])
    expect(after.runs.size).toBe(1)
    expect(after.terminal).toBeNull()
  })

  it('rejects unordered, duplicate, out-of-watermark, and malformed stale entries', () => {
    const s = event('run_started')
    const state = foldTimeline([snapshot(10, [s], [5])])
    for (const frame of [
      snapshot(8, [s, s], [6, 5]),
      snapshot(8, [s, s], [5, 5]),
      snapshot(8, [s], [9]),
      snapshot(0, [s], [0]),
      {
        kind: 'snapshot',
        cursor: 2,
        entries: [{ cursor: 1, event: { type: 'run_started' } }],
      },
      { kind: 'delta', cursor: 2, event: { type: 'run_started' } },
    ])
      expect(() => reduceTimeline(state, frame as never)).toThrow()
    expect(reduceTimeline(emptyTimeline(), snapshot(0, [])).events).toEqual([])
    expect(reduceTimeline(emptyTimeline(), snapshot(100, [])).cursor).toBe(100)
  })

  it('rejects conflicting known cursor payloads without changing state', () => {
    const s = event('run_started')
    const state = foldTimeline([{ kind: 'delta', cursor: 5, event: s }])
    const changed = event('run_started', { runId: 'changed' })
    expect(() =>
      reduceTimeline(state, { kind: 'delta', cursor: 5, event: changed }),
    ).toThrow()
    expect(() => reduceTimeline(state, snapshot(10, [changed], [5]))).toThrow()
    expect(reduceTimeline(state, { kind: 'delta', cursor: 5, event: s })).toBe(
      state,
    )
    expect(state.events).toEqual([s])
  })
})
