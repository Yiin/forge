import type { ChatRenderItem } from './render-model'

/** Prompt rail rules after zeron (crates/ui/src/rail.rs). */
export const RAIL_MIN_WIDTH = 768
export const RAIL_MIN_PROMPTS = 2
export const RAIL_MAX_TICKS = 12
export const RAIL_SLOT_PX = 10
export const RAIL_GAP_PX = 3
export const RAIL_V_MARGIN = 24
export const PROMPT_PREVIEW_CHARS = 160
export const REPLY_PREVIEW_CHARS = 200
/**
 * The reading line sits just under the top of the scroller. zeron adds its
 * 38px overlaid titlebar; forge's titlebar sits above the scroller.
 */
export const READING_LINE_PX = 10.5
export const GLIDE_MS = 500

export type RailPrompt = {
  /** Index of the prompt's row in the transcript items. */
  index: number
  text: string
  reply?: string
}

/** One tick per prompt, with the opening of the reply that followed it. */
export function railPrompts(items: ChatRenderItem[]): RailPrompt[] {
  const prompts: RailPrompt[] = []
  items.forEach((item, index) => {
    if (item.kind !== 'message') return
    if (item.role === 'user') {
      prompts.push({ index, text: item.text })
      return
    }
    const current = prompts.at(-1)
    if (current && current.reply === undefined && !item.thought) {
      const reply = item.text.trim()
      if (reply) current.reply = reply
    }
  })
  return prompts
}

export function showRail(width: number, prompts: number) {
  return width - 10 >= RAIL_MIN_WIDTH && prompts >= RAIL_MIN_PROMPTS
}

/** How many ticks fit the viewport height, capped at 12. */
export function railCapacity(height: number) {
  const fit = Math.floor(
    (height - 2 * RAIL_V_MARGIN + RAIL_GAP_PX) / (RAIL_SLOT_PX + RAIL_GAP_PX),
  )
  return Math.min(RAIL_MAX_TICKS, Math.max(1, fit))
}

/** Split `count` prompts into at most `cap` even buckets of [start, end). */
export function railBuckets(count: number, cap: number) {
  const slots = Math.min(count, cap)
  return Array.from({ length: slots }, (_, bucket) => ({
    start: Math.floor((bucket * count) / slots),
    end: Math.floor(((bucket + 1) * count) / slots),
  }))
}

/**
 * The last prompt whose row top is at or above the reading line. Before the
 * first prompt, the first one is active.
 */
export function activePrompt(offsets: number[], readingLine: number) {
  let active = 0
  offsets.forEach((offset, index) => {
    if (offset <= readingLine) active = index
  })
  return active
}

/** Collapse whitespace and cut to `max` characters with an ellipsis. */
export function previewText(text: string, max: number) {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1).trimEnd()}…`
}
