import { harnessEventSchema, type HarnessEvent } from './harness.js'
import { z } from 'zod'

export const timelineFrameSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('snapshot'),
    cursor: z.number().int().nonnegative(),
    events: z.array(harnessEventSchema),
  }),
  z.object({
    kind: z.literal('delta'),
    cursor: z.number().int().nonnegative(),
    event: harnessEventSchema,
  }),
])
export type TimelineFrame = z.infer<typeof timelineFrameSchema>
export type TimelineState = {
  cursor: number
  events: HarnessEvent[]
  completedTurns: Set<string>
  terminal: 'completed' | 'failed' | null
  terminalByRun: Map<string, 'completed' | 'failed'>
  activeRunId: string | null
  activeTurnId: string | null
  activeGeneration: string | null
  generations: Set<string>
}
export const emptyTimeline = (): TimelineState => ({
  cursor: 0,
  events: [],
  completedTurns: new Set(),
  terminal: null,
  terminalByRun: new Map(),
  activeRunId: null,
  activeTurnId: null,
  activeGeneration: null,
  generations: new Set(),
})
const eventKey = (event: HarnessEvent) =>
  `${event.runtimeGeneration ?? 'legacy'}:${event.deliveryId ?? event.type + ':' + ('turnId' in event ? event.turnId : event.runId)}`

function derive(events: HarnessEvent[]) {
  const completedTurns = new Set<string>(),
    terminalByRun = new Map<string, 'completed' | 'failed'>()
  let activeRunId: string | null = null,
    activeTurnId: string | null = null,
    activeGeneration: string | null = null
  const generations = new Set<string>()
  for (const event of events) {
    generations.add(event.runtimeGeneration)
    if (event.type === 'run_started') {
      activeRunId = event.runId
      activeTurnId = null
      activeGeneration = event.runtimeGeneration
    }
    if (event.type === 'turn_started') {
      activeRunId = event.runId
      activeTurnId = event.turnId
      activeGeneration = event.runtimeGeneration
    }
    if (event.type === 'turn_completed') {
      completedTurns.add(event.turnId)
      const runId = event.runId ?? '__legacy__'
      if (!terminalByRun.has(runId)) terminalByRun.set(runId, 'completed')
    }
    if (event.type === 'run_failed' && !terminalByRun.has(event.runId))
      terminalByRun.set(event.runId, 'failed')
  }
  const runTerminal = activeRunId ? terminalByRun.get(activeRunId) : null
  const terminal =
    runTerminal === 'failed'
      ? 'failed'
      : activeTurnId && completedTurns.has(activeTurnId)
        ? 'completed'
        : activeRunId
          ? null
          : (terminalByRun.values().next().value ?? null)
  return {
    completedTurns,
    terminalByRun,
    activeRunId,
    activeTurnId,
    activeGeneration,
    generations,
    terminal,
  }
}

export function reduceTimeline(
  state: TimelineState,
  frame: TimelineFrame,
): TimelineState {
  if (frame.kind === 'snapshot' && frame.cursor < state.cursor) return state
  if (frame.kind === 'delta' && frame.cursor <= state.cursor) return state
  const incoming = frame.kind === 'snapshot' ? frame.events : [frame.event]
  const seen = new Set(state.events.map(eventKey))
  const accepted = incoming.filter(
    (event) =>
      !seen.has(eventKey(event)) &&
      !(
        state.activeGeneration &&
        state.generations.has(event.runtimeGeneration) &&
        event.runtimeGeneration !== state.activeGeneration
      ),
  )
  const events =
    frame.kind === 'snapshot' ? incoming : [...state.events, ...accepted]
  return { cursor: frame.cursor, events, ...derive(events) }
}
export function foldTimeline(frames: TimelineFrame[]): TimelineState {
  return frames.reduce(reduceTimeline, emptyTimeline())
}
