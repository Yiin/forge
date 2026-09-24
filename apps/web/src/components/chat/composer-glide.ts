/**
 * The hand-off between the new-session composer and the session's docked
 * composer. The draft route records where its pill sat just before it
 * navigates; the session route picks that up on mount, and its composer
 * glides from there to the dock (zeron composer_dock.rs). The two routes
 * mount different composers, so this record is what makes them read as one.
 */
export type GlideRect = {
  left: number
  top: number
  width: number
  height: number
}

export type ComposerGlide = {
  sessionId: string
  /** The prompt the send put in the transcript, for the send runway. */
  itemId: string
  selection: { harness?: string; accountId?: string; model?: string }
  pill: GlideRect
  /** Copies of the hero-only chrome, faded out where they stood. */
  ghosts: Array<{ node: HTMLElement; rect: GlideRect }>
  at: number
}

/** A hand-off older than this belongs to a navigation that never landed. */
const MAX_AGE_MS = 5000
let pending: ComposerGlide | undefined

const rectOf = (node: Element): GlideRect => {
  const { left, top, width, height } = node.getBoundingClientRect()
  return { left, top, width, height }
}

/** Record the hero composer inside `hero` before the route changes. */
export function captureComposerGlide(
  hero: HTMLElement | null,
  input: Pick<ComposerGlide, 'sessionId' | 'itemId' | 'selection'>,
) {
  const pill = hero?.querySelector('.chat-composer-glass')
  if (!hero || !pill) return
  pending = {
    ...input,
    pill: rectOf(pill),
    ghosts: [...hero.querySelectorAll<HTMLElement>('[data-glide-ghost]')].map(
      (node) => ({
        node: node.cloneNode(true) as HTMLElement,
        rect: rectOf(node),
      }),
    ),
    at: performance.now(),
  }
}

/** The hand-off for `sessionId`, if its navigation just happened. */
export function peekComposerGlide(sessionId: string) {
  if (
    pending?.sessionId === sessionId &&
    performance.now() - pending.at < MAX_AGE_MS
  )
    return pending
  return undefined
}

/** The glide started (or never will): later mounts must not replay it. */
export function clearComposerGlide(glide: ComposerGlide) {
  if (pending === glide) pending = undefined
}
