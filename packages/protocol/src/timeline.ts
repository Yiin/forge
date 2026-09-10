import { z } from 'zod'
import { harnessEventSchema, type HarnessEvent } from './harness.js'

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
}

export const emptyTimeline = (): TimelineState => ({
  cursor: 0,
  events: [],
  completedTurns: new Set(),
  terminal: null,
  terminalByRun: new Map(),
  activeRunId: null,
})

const eventKey = (event: HarnessEvent) =>
  (('deliveryId' in event && event.deliveryId) ||
    ('receiptId' in event && event.receiptId) ||
    ('itemId' in event && event.itemId) ||
    ('turnId' in event ? `${event.type}:${event.turnId}` : 'runId' in event ? `${event.type}:${event.runId}` : JSON.stringify(event))) as string

export function reduceTimeline(
  state: TimelineState,
  frame: TimelineFrame,
): TimelineState {
  const incoming = frame.kind === 'snapshot' ? frame.events : [frame.event]
  if (frame.cursor <= state.cursor && frame.kind === 'delta') return state
  const incomingKeys = new Set(incoming.map(eventKey))
  const events = frame.kind === 'snapshot' && frame.cursor >= state.cursor
    ? []
    : frame.kind === 'snapshot'
      ? state.events.filter((event) => !incomingKeys.has(eventKey(event)))
    : [...state.events]
  const seen = new Set(events.map(eventKey))
  const completedTurns = new Set(state.completedTurns)
  const terminalByRun = new Map(state.terminalByRun)
  let activeRunId = state.activeRunId
  for (const event of incoming) {
    if (seen.has(eventKey(event))) continue
    seen.add(eventKey(event))
    events.push(event)
    if (event.type === 'run_started') activeRunId = event.runId
    if (event.type === 'turn_completed') {
      completedTurns.add(event.turnId)
      terminalByRun.set('runId' in event ? event.runId ?? '__legacy__' : '__legacy__', 'completed')
    }
    if (event.type === 'run_failed') terminalByRun.set(event.runId, 'failed')
  }
  return {
    cursor: Math.max(state.cursor, frame.cursor),
    events,
    completedTurns,
    terminal: activeRunId
      ? terminalByRun.get(activeRunId) ?? null
      : [...terminalByRun.values()].at(-1) ?? null,
    terminalByRun,
    activeRunId,
  }
}

export function foldTimeline(frames: TimelineFrame[]): TimelineState {
  return frames.reduce(reduceTimeline, emptyTimeline())
}
