/**
 * The composer pill's motion as pure math, after zeron's composer.rs
 * (flip morph, 311-485) and composer_dock.rs (the first-send dock, 16-43
 * and 196-219). pill-motion.ts applies these values to the DOM.
 */
import { clamp01, easeOut, lerp } from './motion'

/** zeron COLLAPSE: one compact/expanded flip. */
export const COLLAPSE_MS = 180
/** zeron dock spring: the hero composer settling into the thread. */
export const DOCK_MS = 420
/** Flips this soon after a route or session change snap. */
export const ROUTE_SNAP_MS = 250
/** Reduced motion swaps the travel for a short crossfade. */
export const CROSSFADE_MS = 150
/** zeron COMPOSER_RADIUS on the hero, and the docked radius. */
export const HERO_RADIUS = 26
export const DOCKED_RADIUS = 22

export function smoothstep(edge0: number, edge1: number, value: number) {
  const x = clamp01((value - edge0) / (edge1 - edge0))
  return x * x * (3 - 2 * x)
}

/**
 * A critically damped spring from 0 to 1 with ω = 12 / duration, as
 * zeron's dock. It lands within 0.01% at `duration`, where it snaps to 1.
 */
export function dockSpring(elapsed: number, duration = DOCK_MS) {
  if (elapsed <= 0) return 0
  if (elapsed >= duration) return 1
  const x = (12 / duration) * elapsed
  return 1 - (1 + x) * Math.exp(-x)
}

/** Progress of a compact/expanded flip, eased like zeron's COLLAPSE. */
export function collapseProgress(elapsed: number) {
  return easeOut(clamp01(elapsed / COLLAPSE_MS))
}

/**
 * The model chip changes slots by fading out, jumping, and fading in with a
 * 6px drift (zeron `model_handoff`). The DOM jumps at the commit, so only
 * the second half plays: hidden until just past the midpoint, then in.
 */
export function chipHandoff(progress: number, toExpanded: boolean) {
  const opacity = Math.max(0, progress - 0.56) / 0.44
  return { opacity, drift: (1 - opacity) * (toExpanded ? 6 : -6) }
}

/** Where the pill is, `progress` of the way from `from` to `to`. */
export function pillOffset(
  from: { x: number; y: number },
  to: { x: number; y: number },
  progress: number,
) {
  return {
    x: (from.x - to.x) * (1 - progress),
    y: (from.y - to.y) * (1 - progress),
  }
}

export type DockFrame = {
  done: boolean
  /** Position, width and height progress, on the spring. */
  travel: number
  radius: number
  /** The hero-only chrome (destination chips, Git chips) fading out. */
  heroChrome: number
  /** The thread footer fading in. */
  footer: number
  /** The transcript fading in, and how far it still sits below its place. */
  transcript: number
  transcriptShift: number
}

/**
 * One frame of the first-send dock. Position and size ride the spring; the
 * staged fades run on the raw clock, each a smoothstep (composer_dock.rs
 * 196-219). Reduced motion keeps everything in place and crossfades.
 */
export function dockFrame(elapsed: number, reducedMotion = false): DockFrame {
  if (reducedMotion) {
    const fade = smoothstep(0, 1, elapsed / CROSSFADE_MS)
    return {
      done: elapsed >= CROSSFADE_MS,
      travel: 1,
      radius: DOCKED_RADIUS,
      heroChrome: 1 - fade,
      footer: fade,
      transcript: fade,
      transcriptShift: 0,
    }
  }
  const clock = clamp01(elapsed / DOCK_MS)
  const travel = dockSpring(elapsed)
  const transcript = smoothstep(0.2, 0.65, clock)
  return {
    done: elapsed >= DOCK_MS,
    travel,
    radius: lerp(HERO_RADIUS, DOCKED_RADIUS, travel),
    heroChrome: 1 - smoothstep(0, 0.25, clock),
    footer: smoothstep(0.25, 0.55, clock),
    transcript,
    transcriptShift: 8 * (1 - transcript),
  }
}
