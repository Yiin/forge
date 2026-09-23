/**
 * How new tool rows arrive, after zeron (crates/ui/src/transcript.rs): each
 * row's height grows in over 360ms, the tree connector draws over 480ms, and
 * the row's content fades in and lifts with the connector's branch. Rows of
 * one arrival stagger. Pure timing; ToolGroup plays it.
 */
import type { ChatRenderItem } from './render-model'
import { clamp01, easeOutQuint } from './motion'

export const TOOL_ROW_REVEAL_MS = 360
export const TOOL_ROW_REVEAL_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)'
export const TOOL_CONNECTOR_MS = 480
/** The first row of a new group waits for its header. */
export const TOOL_FIRST_ROW_DELAY_MS = 90
export const TOOL_ROW_STAGGER_MS = 65
/** Reduced motion: a plain, short fade in place. */
export const TOOL_ROW_FADE_MS = 150
/** How far the content lifts as it fades in. */
export const TOOL_ROW_LIFT_PX = 4

/**
 * When each tool row and group arrived, by id: a start time for the ones
 * that animate, `null` for history. Absent means not seen yet.
 */
export type Arrivals = Map<string, number | null>

/** An arrival's start: the first row of a new group waits, the rest stagger. */
export function arrivalDelay(order: number, newGroup: boolean) {
  return (newGroup ? TOOL_FIRST_ROW_DELAY_MS : 0) + order * TOOL_ROW_STAGGER_MS
}

/**
 * Note the tool groups and rows in `items` that were not seen before. With
 * `animate` off (while the transcript first lands) they count as history.
 */
export function noteArrivals(
  arrivals: Arrivals,
  items: readonly ChatRenderItem[],
  now: number,
  animate: boolean,
) {
  for (const item of items) {
    if (item.kind !== 'tool-group') continue
    const newGroup = !arrivals.has(item.id)
    if (newGroup) arrivals.set(item.id, animate ? now : null)
    let order = 0
    for (const entry of item.entries) {
      if (arrivals.has(entry.id)) continue
      arrivals.set(
        entry.id,
        animate ? now + arrivalDelay(order, newGroup) : null,
      )
      order += 1
    }
  }
}

/**
 * Split one connector draw into its incoming trunk and its branch. With a
 * row above, the row above first extends its trunk down (see
 * `connectorContinuation`), then this row draws its trunk and elbow. The
 * branch overlaps the end of the trunk so the bend has no dead frame.
 */
export function connectorParts(progress: number, hasPredecessor: boolean) {
  const p = clamp01(progress)
  const [incomingStart, incomingEnd, branchStart] = hasPredecessor
    ? [0.45, 0.72, 0.68]
    : [0, 0.62, 0.58]
  return {
    incoming: clamp01((p - incomingStart) / (incomingEnd - incomingStart)),
    branch: clamp01((p - branchStart) / (1 - branchStart)),
  }
}

/** The row above extends its trunk during the next row's first 45%. */
export function connectorContinuation(nextProgress: number) {
  return clamp01(nextProgress / 0.45)
}

/**
 * Keyframes for one connector part: `part` maps the connector's eased
 * progress to the part's own, sampled evenly in time. Played linearly, they
 * trace the 480ms quint-out draw exactly at every sample.
 */
export function connectorFrames(
  part: (progress: number) => number,
  steps = 24,
) {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const offset = index / steps
    return { offset, value: part(easeOutQuint(offset)) }
  })
}
