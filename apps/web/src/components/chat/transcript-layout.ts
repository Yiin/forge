import type { ChatRenderItem } from './render-model'
import type { PendingUserMessage } from '../../stores/messages'

/**
 * Transcript rhythm after zeron (crates/ui/src/transcript.rs `top_gap_for`).
 * Forge's titlebar sits above the scroller instead of over it, so the first
 * row keeps only the part of zeron's 64px inset that clears the titlebar.
 */
export const FIRST_ROW_GAP = 26
export const ENTRY_GAP = 16
export const BLOCK_GAP = 12
export const ROW_GAP = 8
/** Space between an attachment and the bubble it belongs to. */
export const ATTACHMENT_GAP = 4
/** The last row clears the composer by the 24px fade band plus 8px. */
export const BOTTOM_CLEARANCE = 32

export type RowMeta = {
  /** Space above the row, in px. */
  gap: number
  /** Present on the row that carries its entry's hover lane. */
  lane?: { copyText: string }
  /** The reply row still receiving text. */
  streaming: boolean
}

const isUserMessage = (item: ChatRenderItem) =>
  item.kind === 'message' && item.role === 'user'
const isUserSide = (item: ChatRenderItem) =>
  isUserMessage(item) || item.kind === 'attachment'
const isReplyText = (item: ChatRenderItem) =>
  item.kind === 'message' && item.role === 'agent' && !item.thought

export function rowGap(prev: ChatRenderItem | undefined, item: ChatRenderItem) {
  if (!prev) return FIRST_ROW_GAP
  if (prev.kind === 'attachment' && isUserSide(item)) return ATTACHMENT_GAP
  if (isUserSide(item) || item.kind === 'working') return ENTRY_GAP
  if (isUserSide(prev)) return ENTRY_GAP
  if (item.kind === 'tool-group' || prev.kind === 'tool-group') return BLOCK_GAP
  if (isReplyText(item) && isReplyText(prev)) return BLOCK_GAP
  return ROW_GAP
}

/**
 * Per-row layout facts. An assistant entry is the run of rows between two
 * prompts. Its last reply text carries the hover lane, whose copy joins
 * every reply text of the entry, but only once the entry has settled: no
 * lane shows while the turn is still running.
 */
export function rowMeta(items: ChatRenderItem[], running: boolean): RowMeta[] {
  const meta: RowMeta[] = items.map((item, index) => ({
    gap: rowGap(items[index - 1], item),
    streaming: false,
  }))
  const content = items.filter((item) => item.kind !== 'working')
  // A running turn whose reply has not started yet leaves the entry before
  // the prompt settled.
  const tail = content.at(-1)
  const liveEntryStart =
    running && tail && !isUserSide(tail)
      ? lastIndexWhere(content, isUserSide) + 1
      : Infinity
  let texts: { index: number; text: string }[] = []
  const flush = () => {
    const last = texts.at(-1)
    if (last)
      meta[last.index].lane = {
        copyText: texts
          .map((entry) => entry.text.trim())
          .filter(Boolean)
          .join('\n\n'),
      }
    texts = []
  }
  let contentIndex = -1
  items.forEach((item, index) => {
    if (item.kind === 'working') return
    contentIndex += 1
    if (isUserSide(item)) {
      flush()
      return
    }
    if (contentIndex >= liveEntryStart) {
      texts = []
      if (contentIndex === content.length - 1 && isReplyText(item))
        meta[index].streaming = true
      return
    }
    if (isReplyText(item) && item.kind === 'message')
      texts.push({ index, text: item.text })
  })
  flush()
  return meta
}

function lastIndexWhere<T>(list: T[], test: (item: T) => boolean) {
  for (let index = list.length - 1; index >= 0; index -= 1)
    if (test(list[index])) return index
  return -1
}

/** zeron's rotating working words, one every 7 seconds, seeded per chat. */
export const FLAVOUR_WORDS = [
  'Zeroning',
  'Thinking',
  'Pondering',
  'Scheming',
  'Brewing',
  'Weaving',
  'Tinkering',
  'Musing',
  'Composing',
  'Sifting',
  'Untangling',
  'Distilling',
  'Sketching',
  'Plotting',
  'Riffing',
  'Combobulating',
  'Percolating',
  'Marinating',
  'Noodling',
  'Puzzling',
  'Conjuring',
] as const
export const FLAVOUR_ROTATE_SECONDS = 7

/** 32-bit FNV-1a: a stable seed from a session id. */
export function fnv1a(text: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

export function flavourWord(seed: number, elapsedSeconds: number) {
  const step = Math.floor(Math.max(0, elapsedSeconds) / FLAVOUR_ROTATE_SECONDS)
  return FLAVOUR_WORDS[(seed + step) % FLAVOUR_WORDS.length]
}

/** "12s", "3m 4s", "2h 5m", "1d 3h". */
export function formatElapsed(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  if (seconds < 86_400)
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
  return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3600)}h`
}

/** "Jul 1, 3:45 PM". */
export function formatTimestamp(iso: string | undefined) {
  if (!iso) return undefined
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/**
 * "Sending…" bridges a send and its turn: while the newest send is fresher
 * than the latest turn start, a timer would count the round trip and then
 * restart when the turn begins.
 */
export function sendingBridge(
  sendStarted: string | undefined,
  turnStarted: string | undefined,
) {
  if (!sendStarted) return false
  if (!turnStarted) return true
  return Date.parse(turnStarted) <= Date.parse(sendStarted)
}

/**
 * What the working line says, after zeron's trailer (transcript.rs
 * `render_working_trailer`):
 * - `queued`: a prompt is waiting and the connection is down. It goes out
 *   by itself when the connection returns.
 * - `undelivered`: a prompt never reached the server and the connection is
 *   up, so only the user's retry sends it again.
 * - `sending`: a prompt is on its way and its turn has not started.
 * - `working`: the turn runs.
 */
export type WorkingPhase = 'working' | 'sending' | 'queued' | 'undelivered'

export function workingPhase({
  pending,
  offline,
  running,
  turnStartedAt,
}: {
  pending: PendingUserMessage[]
  offline: boolean
  running: boolean
  turnStartedAt?: string
}): WorkingPhase {
  const waiting = pending.filter(
    (item) => (item.status ?? 'sending') !== 'accepted',
  )
  if (offline && waiting.length) return 'queued'
  if (pending.some((item) => item.status === 'unsent')) return 'undelivered'
  if (!running || sendingBridge(pending.at(-1)?.createdAt, turnStartedAt))
    return 'sending'
  return 'working'
}
