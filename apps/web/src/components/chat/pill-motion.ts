/**
 * Drives the composer pill once per animation frame: the compact/expanded
 * flip morph and the first-send dock glide. The math is in
 * composer-motion.ts; this class only reads and writes the DOM.
 *
 * The pill is a clipping shell around a content box. Between motions the
 * shell sizes to its content. During one, the shell's height is written
 * each frame toward the content's live height, the content stays pinned to
 * the shell's bottom edge, and the controls and text are offset from where
 * they sat so nothing jumps.
 */
import type { ComposerGlide } from './composer-glide'
import {
  chipHandoff,
  collapseProgress,
  COLLAPSE_MS,
  dockFrame,
  pillOffset,
} from './composer-motion'
import { lerp, prefersReducedMotion } from './motion'

export type PillParts = {
  root: HTMLElement
  pill: HTMLElement
  content: HTMLElement
  attach: HTMLElement
  textarea: HTMLElement
  /** The box around the textarea and its painted layer; it moves. */
  textBox: HTMLElement
  chip: HTMLElement
  send: HTMLElement
  footer: HTMLElement
}

type Point = { x: number; y: number }
type Snapshot = { height: number; parts: Map<HTMLElement, Point> }

type Morph = {
  start: number
  from: number
  toExpanded: boolean
  offsets: Map<HTMLElement, Point>
}

type Glide = {
  start: number
  reduced: boolean
  from: { width: number; height: number; center: Point }
  to: { width: number; center: Point }
  /** The chip changes slots on the way (hero expanded, dock compact). */
  chipMoves: boolean
  transcript?: HTMLElement
  /** Chrome of the session route that fades in with the footer. */
  fades: HTMLElement[]
  /** The overlay that clips the composer, opened up for the travel. */
  overlay?: HTMLElement
  ghosts: HTMLElement[]
}

export class PillMotion {
  private frame = 0
  private snapshot?: Snapshot
  private morph?: Morph
  private glide?: Glide

  constructor(private parts: () => PillParts | undefined) {}

  dispose() {
    cancelAnimationFrame(this.frame)
    this.frame = 0
    this.finishMorph()
    this.finishGlide()
  }

  /** Where the text and controls sit now, relative to the pill's bottom. */
  private positions(parts: PillParts) {
    const box = parts.pill.getBoundingClientRect()
    const map = new Map<HTMLElement, Point>()
    for (const node of [parts.attach, parts.textarea, parts.send]) {
      const rect = node.getBoundingClientRect()
      const style = node === parts.textarea ? getComputedStyle(node) : null
      map.set(node === parts.textarea ? parts.textBox : node, {
        x: rect.left - box.left + (style ? parseFloat(style.paddingLeft) : 0),
        y: rect.top - box.bottom + (style ? parseFloat(style.paddingTop) : 0),
      })
    }
    return map
  }

  /** A flip is about to commit: remember what the pill looks like now. */
  beforeFlip() {
    const parts = this.parts()
    if (!parts || this.glide) return
    this.snapshot = {
      height: parts.pill.getBoundingClientRect().height,
      parts: this.positions(parts),
    }
  }

  /**
   * The flip committed. Morph from the snapshot unless motion is reduced or
   * the flip came with a navigation, which snaps.
   */
  afterFlip(expanded: boolean, snap: boolean) {
    const snapshot = this.snapshot
    this.snapshot = undefined
    const parts = this.parts()
    if (!parts || !snapshot || this.glide) return
    this.finishMorph()
    if (snap || prefersReducedMotion() || snapshot.height <= 0) return
    const now = this.positions(parts)
    const offsets = new Map<HTMLElement, Point>()
    for (const [node, before] of snapshot.parts) {
      const after = now.get(node)
      if (after)
        offsets.set(node, { x: before.x - after.x, y: before.y - after.y })
    }
    this.morph = {
      start: performance.now(),
      from: snapshot.height,
      toExpanded: expanded,
      offsets,
    }
    this.applyMorph(parts, this.morph.start)
    this.kick()
  }

  /**
   * Glide from the hero pill recorded in `handoff` to where the pill now
   * sits. Called before the first paint, so the first frame is already at
   * the hero position.
   */
  startGlide(handoff: ComposerGlide, expanded: boolean) {
    const parts = this.parts()
    if (!parts) return
    this.finishMorph()
    const box = parts.pill.getBoundingClientRect()
    const reduced = prefersReducedMotion()
    const pane = parts.root.closest('[data-chat-pane]')
    const ghosts = handoff.ghosts.map(({ node, rect }) => {
      Object.assign(node.style, {
        position: 'fixed',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        margin: '0',
        pointerEvents: 'none',
        zIndex: '45',
      })
      node.setAttribute('aria-hidden', 'true')
      node.removeAttribute('data-glide-ghost')
      node.setAttribute('data-glide-copy', '')
      document.body.append(node)
      return node
    })
    this.glide = {
      start: performance.now(),
      reduced,
      from: {
        width: handoff.pill.width,
        height: handoff.pill.height,
        center: {
          x: handoff.pill.left + handoff.pill.width / 2,
          y: handoff.pill.top + handoff.pill.height,
        },
      },
      to: {
        width: box.width,
        center: { x: box.left + box.width / 2, y: box.bottom },
      },
      chipMoves: !expanded,
      transcript:
        pane?.querySelector<HTMLElement>('.chat-timeline-shell') ?? undefined,
      fades: [
        ...(pane?.querySelectorAll<HTMLElement>('[data-glide-fade]') ?? []),
      ],
      overlay:
        parts.root.closest<HTMLElement>('[data-composer-overlay]') ?? undefined,
      ghosts,
    }
    if (this.glide.overlay) this.glide.overlay.style.overflow = 'visible'
    this.applyGlide(parts, this.glide.start)
    this.kick()
  }

  private kick() {
    if (!this.frame) this.frame = requestAnimationFrame(this.tick)
  }

  private tick = (now: number) => {
    this.frame = 0
    const parts = this.parts()
    if (!parts) return
    if (this.glide) this.applyGlide(parts, now)
    else if (this.morph) this.applyMorph(parts, now)
    if (this.glide || this.morph) this.kick()
  }

  /** The shell's height when it fits its content. */
  private target(parts: PillParts) {
    const border = parts.pill.offsetHeight - parts.pill.clientHeight
    return parts.content.offsetHeight + border
  }

  private applyMorph(parts: PillParts, now: number) {
    const morph = this.morph!
    const elapsed = now - morph.start
    if (elapsed >= COLLAPSE_MS) {
      this.finishMorph()
      return
    }
    const progress = collapseProgress(elapsed)
    parts.pill.style.height = `${lerp(morph.from, this.target(parts), progress)}px`
    for (const [node, offset] of morph.offsets)
      node.style.transform = `translate(${offset.x * (1 - progress)}px, ${offset.y * (1 - progress)}px)`
    const chip = chipHandoff(progress, morph.toExpanded)
    parts.chip.style.opacity = `${chip.opacity}`
    parts.chip.style.transform = `translateX(${chip.drift}px)`
  }

  private finishMorph() {
    const morph = this.morph
    this.morph = undefined
    const parts = this.parts()
    if (!morph || !parts) return
    parts.pill.style.height = ''
    for (const node of morph.offsets.keys()) node.style.transform = ''
    parts.chip.style.opacity = ''
    parts.chip.style.transform = ''
  }

  private applyGlide(parts: PillParts, now: number) {
    const glide = this.glide!
    const frame = dockFrame(now - glide.start, glide.reduced)
    if (frame.done) {
      this.finishGlide()
      return
    }
    for (const ghost of glide.ghosts) {
      ghost.style.opacity = `${frame.heroChrome}`
      // The hero chrome rides along with the pill while it fades.
      if (!glide.reduced)
        ghost.style.transform = `translate(${(glide.to.center.x - glide.from.center.x) * frame.travel}px, ${(glide.to.center.y - glide.from.center.y) * frame.travel}px)`
    }
    if (glide.transcript) {
      glide.transcript.style.opacity = `${frame.transcript}`
      glide.transcript.style.transform = frame.transcriptShift
        ? `translateY(${frame.transcriptShift}px)`
        : ''
    }
    parts.footer.style.opacity = `${frame.footer}`
    for (const node of glide.fades) node.style.opacity = `${frame.footer}`
    if (glide.chipMoves) parts.chip.style.opacity = `${frame.footer}`
    if (glide.reduced) {
      parts.root.style.opacity = `${frame.footer}`
      return
    }
    const offset = pillOffset(glide.from.center, glide.to.center, frame.travel)
    parts.root.style.transform = `translate(${offset.x}px, ${offset.y}px)`
    parts.pill.style.width = `${lerp(glide.from.width, glide.to.width, frame.travel)}px`
    parts.pill.style.marginInline = 'auto'
    parts.pill.style.height = `${lerp(glide.from.height, this.target(parts), frame.travel)}px`
    parts.pill.style.borderRadius = `${frame.radius}px`
  }

  private finishGlide() {
    const glide = this.glide
    this.glide = undefined
    if (!glide) return
    for (const ghost of glide.ghosts) ghost.remove()
    for (const node of glide.fades) node.style.opacity = ''
    if (glide.overlay) glide.overlay.style.overflow = ''
    if (glide.transcript) {
      glide.transcript.style.opacity = ''
      glide.transcript.style.transform = ''
    }
    const parts = this.parts()
    if (!parts) return
    for (const property of [
      'height',
      'width',
      'marginInline',
      'borderRadius',
    ] as const)
      parts.pill.style[property] = ''
    parts.root.style.transform = ''
    parts.root.style.opacity = ''
    parts.footer.style.opacity = ''
    parts.chip.style.opacity = ''
  }
}
