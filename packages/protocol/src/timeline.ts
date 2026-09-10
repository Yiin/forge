import { z } from 'zod'
import { harnessEventSchema, type HarnessEvent } from './harness.js'

export const timelineFrameSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('snapshot'), cursor: z.number().int().nonnegative(), events: z.array(harnessEventSchema) }),
  z.object({ kind: z.literal('delta'), cursor: z.number().int().nonnegative(), event: harnessEventSchema }),
])
export type TimelineFrame = z.infer<typeof timelineFrameSchema>

export type TimelineState = {
  cursor: number
  events: HarnessEvent[]
  completedTurns: Set<string>
  terminal: 'completed' | 'failed' | null
}

export const emptyTimeline = (): TimelineState => ({
  cursor: 0,
  events: [],
  completedTurns: new Set(),
  terminal: null,
})

const eventKey = (event: HarnessEvent) =>
  'receiptId' in event ? event.receiptId : 'itemId' in event ? event.itemId : 'turnId' in event ? `${event.type}:${event.turnId}` : 'runId' in event ? `${event.type}:${event.runId}` : JSON.stringify(event)

export function reduceTimeline(state: TimelineState, frame: TimelineFrame): TimelineState {
  const incoming = frame.kind === 'snapshot' ? frame.events : [frame.event]
  if (frame.cursor <= state.cursor && frame.kind === 'delta') return state
  const seen = new Set(state.events.map(eventKey))
  const events = [...state.events]
  const completedTurns = new Set(state.completedTurns)
  let terminal = state.terminal
  for (const event of incoming) {
    if (seen.has(eventKey(event))) continue
    seen.add(eventKey(event))
    events.push(event)
    if (event.type === 'turn_completed') completedTurns.add(event.turnId)
    if (event.type === 'run_failed') terminal = 'failed'
  }
  if (incoming.some((event) => event.type === 'turn_completed')) terminal = terminal ?? 'completed'
  return { cursor: Math.max(state.cursor, frame.cursor), events, completedTurns, terminal }
}

export function foldTimeline(frames: TimelineFrame[]): TimelineState {
  return frames.reduce(reduceTimeline, emptyTimeline())
}
