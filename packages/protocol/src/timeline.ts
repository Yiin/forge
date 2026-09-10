import {
  harnessEventSchema,
  type HarnessEvent,
  type TerminalOutcome,
} from './harness.js'
import { z } from 'zod'

export const timelineEntrySchema = z.object({
  cursor: z.number().int().positive(),
  event: harnessEventSchema,
})
export type TimelineEntry = z.infer<typeof timelineEntrySchema>

// Snapshots contain the complete history for one timeline through the watermark,
// not a page. Cursors can have gaps. Live delivery must arrive in cursor order.
const snapshotSchema = z
  .object({
    kind: z.literal('snapshot'),
    cursor: z.number().int().nonnegative(),
    entries: z.array(timelineEntrySchema),
  })
  .superRefine((frame, ctx) => {
    let previous = 0
    for (const [index, entry] of frame.entries.entries()) {
      if (entry.cursor <= previous || entry.cursor > frame.cursor) {
        ctx.addIssue({
          code: 'custom',
          path: ['entries', index, 'cursor'],
          message:
            'Snapshot cursors must increase and stay within the watermark',
        })
      }
      previous = entry.cursor
    }
  })
export const timelineFrameSchema = z.discriminatedUnion('kind', [
  snapshotSchema,
  timelineEntrySchema.extend({ kind: z.literal('delta') }),
])
export type TimelineFrame = z.infer<typeof timelineFrameSchema>
export type TimelineTurn =
  | { phase: 'accepted' | 'running' }
  | { phase: 'settled'; outcome: TerminalOutcome }
export type TimelineRun = {
  activeTurnId: string | null
  turns: Map<string, TimelineTurn>
  failure: Extract<TerminalOutcome, { status: 'failed' }> | null
}
export type TimelineState = {
  cursor: number
  snapshotCursor: number
  // Rejected inputs remain available because a replacement prefix can change
  // generation ownership and make a previously rejected suffix valid.
  entries: TimelineEntry[]
  events: HarnessEvent[]
  deliveryIds: Set<string>
  runs: Map<string, TimelineRun>
  terminal: TerminalOutcome['status'] | null
  activeRunId: string | null
  activeTurnId: string | null
  activeGeneration: string | null
  generations: Set<string>
}
export const emptyTimeline = (): TimelineState => ({
  cursor: 0,
  snapshotCursor: 0,
  entries: [],
  events: [],
  deliveryIds: new Set(),
  runs: new Map(),
  terminal: null,
  activeRunId: null,
  activeTurnId: null,
  activeGeneration: null,
  generations: new Set(),
})
export const timelineRunKey = (generation: string, runId: string): string =>
  JSON.stringify([generation, runId])
const eventKey = (event: HarnessEvent): string =>
  JSON.stringify([event.runtimeGeneration, event.deliveryId])

function accepts(state: TimelineState, event: HarnessEvent): boolean {
  return (
    !state.deliveryIds.has(eventKey(event)) &&
    !(
      state.generations.has(event.runtimeGeneration) &&
      event.runtimeGeneration !== state.activeGeneration
    )
  )
}

function terminalOf(run: TimelineRun): TimelineState['terminal'] {
  if (run.failure) return run.failure.status
  for (const turn of run.turns.values())
    if (turn.phase !== 'settled') return null
  const turn =
    run.activeTurnId === null ? undefined : run.turns.get(run.activeTurnId)
  return turn?.phase === 'settled' ? turn.outcome.status : null
}

function applyLifecycle(
  state: TimelineState,
  event: HarnessEvent,
): TimelineState {
  const key = timelineRunKey(event.runtimeGeneration, event.runId)
  const previous = state.runs.get(key)
  let run: TimelineRun = previous ?? {
    activeTurnId: null,
    turns: new Map(),
    failure: null,
  }
  const setTurn = (turnId: string, turn: TimelineTurn) => {
    run = { ...run, turns: new Map(run.turns).set(turnId, turn) }
  }
  if (event.type === 'run_failed') {
    if (!run.failure) {
      const failure = {
        status: 'failed' as const,
        code: event.code,
        message: event.message,
      }
      const turns = new Map(run.turns)
      for (const [turnId, turn] of turns) {
        if (turn.phase !== 'settled')
          turns.set(turnId, { phase: 'settled', outcome: failure })
      }
      run = { ...run, turns, failure }
    }
  } else if (!run.failure) {
    switch (event.type) {
      case 'prompt_accepted':
      case 'steer_accepted':
        if (!run.turns.has(event.turnId))
          setTurn(event.turnId, { phase: 'accepted' })
        break
      case 'turn_started': {
        const turn = run.turns.get(event.turnId)
        if (!turn || turn.phase === 'accepted') {
          setTurn(event.turnId, { phase: 'running' })
          run = { ...run, activeTurnId: event.turnId }
        }
        break
      }
      case 'turn_completed': {
        const turn = run.turns.get(event.turnId)
        if (turn?.phase !== 'settled') {
          const active =
            run.activeTurnId === null
              ? undefined
              : run.turns.get(run.activeTurnId)
          const activates =
            run.activeTurnId === null ||
            (turn?.phase === 'accepted' && active?.phase === 'settled')
          setTurn(event.turnId, { phase: 'settled', outcome: event.outcome })
          if (activates) run = { ...run, activeTurnId: event.turnId }
        }
        break
      }
    }
  }

  const newGeneration = !state.generations.has(event.runtimeGeneration)
  const activates =
    newGeneration ||
    state.activeRunId === null ||
    (previous === undefined &&
      [
        'run_started',
        'turn_started',
        'prompt_accepted',
        'steer_accepted',
      ].includes(event.type))
  if (run === previous && !activates) return state
  const activeRunId = activates ? event.runId : state.activeRunId
  const activeGeneration = activates
    ? event.runtimeGeneration
    : state.activeGeneration
  const isActive =
    activeRunId === event.runId && activeGeneration === event.runtimeGeneration
  return {
    ...state,
    runs: run === previous ? state.runs : new Map(state.runs).set(key, run),
    generations: newGeneration
      ? new Set(state.generations).add(event.runtimeGeneration)
      : state.generations,
    activeRunId,
    activeGeneration,
    activeTurnId: isActive ? run.activeTurnId : state.activeTurnId,
    terminal: isActive ? terminalOf(run) : state.terminal,
  }
}

// Wire object key order has no meaning, including inside tool input and output.
function samePayload(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (
    a === null ||
    b === null ||
    typeof a !== 'object' ||
    typeof b !== 'object'
  )
    return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        samePayload(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        ),
    )
  )
}

function assertSameCursor(
  known: HarnessEvent | undefined,
  incoming: HarnessEvent,
): void {
  if (known && !samePayload(known, incoming))
    throw new Error('Conflicting events at one timeline cursor')
}

function rebuild(entries: TimelineEntry[]): TimelineState {
  let state = emptyTimeline()
  const events: HarnessEvent[] = []
  const deliveryIds = new Set<string>()
  state.deliveryIds = deliveryIds
  for (const { event } of entries) {
    if (!accepts(state, event)) continue
    deliveryIds.add(eventKey(event))
    state = applyLifecycle(state, event)
    events.push(event)
  }
  return { ...state, entries, events }
}

export function reduceTimeline(
  state: TimelineState,
  input: TimelineFrame,
): TimelineState {
  // Validate stale frames too. TypeScript types do not validate a wire payload.
  const frame = timelineFrameSchema.parse(input)
  if (frame.kind === 'snapshot') {
    const known = new Map(
      state.entries.map((entry) => [entry.cursor, entry.event]),
    )
    for (const entry of frame.entries)
      assertSameCursor(known.get(entry.cursor), entry.event)
    if (frame.cursor < state.snapshotCursor) return state
    const entries = [
      ...frame.entries,
      ...state.entries.filter((entry) => entry.cursor > frame.cursor),
    ]
    return {
      ...rebuild(entries),
      cursor: Math.max(state.cursor, frame.cursor),
      snapshotCursor: frame.cursor,
    }
  }
  if (frame.cursor <= state.cursor) {
    assertSameCursor(
      state.entries.find((entry) => entry.cursor === frame.cursor)?.event,
      frame.event,
    )
    return state
  }
  const entries = [
    ...state.entries,
    { cursor: frame.cursor, event: frame.event },
  ]
  if (!accepts(state, frame.event))
    return { ...state, cursor: frame.cursor, entries }
  return {
    ...applyLifecycle(state, frame.event),
    cursor: frame.cursor,
    entries,
    events: [...state.events, frame.event],
    deliveryIds: new Set(state.deliveryIds).add(eventKey(frame.event)),
  }
}
export function foldTimeline(frames: TimelineFrame[]): TimelineState {
  return frames.reduce(reduceTimeline, emptyTimeline())
}
