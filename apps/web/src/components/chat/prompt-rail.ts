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

/**
 * CSS cubic-bezier as a function of time: solves x(t) by Newton steps with
 * a bisection fallback, then returns y.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const curve = (a: number, b: number, t: number) =>
    3 * a * t * (1 - t) ** 2 + 3 * b * t ** 2 * (1 - t) + t ** 3
  const slope = (a: number, b: number, t: number) =>
    3 * a * (1 - t) ** 2 + 6 * (b - a) * t * (1 - t) + 3 * (1 - b) * t ** 2
  return (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let step = 0; step < 8; step += 1) {
      const error = curve(x1, x2, t) - x
      if (Math.abs(error) < 1e-6) return curve(y1, y2, t)
      const d = slope(x1, x2, t)
      if (Math.abs(d) < 1e-6) break
      t -= error / d
    }
    let low = 0
    let high = 1
    t = x
    while (high - low > 1e-6) {
      if (curve(x1, x2, t) < x) low = t
      else high = t
      t = (low + high) / 2
    }
    return curve(y1, y2, t)
  }
}

export const easeInOut = cubicBezier(0.42, 0, 0.58, 1)
