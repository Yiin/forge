/**
 * The transcript's scroll motion after zeron (crates/ui/src/transcript.rs):
 * the stick-to-bottom spring, the own-send runway, and the scroll that keeps
 * a folding prompt in view. Pure math; Timeline drives it once per frame.
 */
import { easeInOut, easeOut, lerp } from './motion'
import { ENTRY_GAP, FIRST_ROW_GAP } from './transcript-layout'

/** Velocity kept per frame (higher = more glide). */
export const SPRING_DAMPING = 0.7
/** Pull toward the target (higher = snappier). */
export const SPRING_STIFFNESS = 0.05
/** Inertia (higher = slower to start and stop). */
export const SPRING_MASS = 1.25
/** The spring integrates in fixed 60fps frames. */
export const FRAME_MS = 1000 / 60
/** A hitch catches up at most this many frames instead of teleporting. */
export const MAX_CATCHUP_FRAMES = 8
/** EMA rate of the target growth estimate. */
export const GROWTH_EMA = 0.12
/** While content grows, chase up to this far above the true bottom. */
export const CHASE_MAX_LEAD = 32
/** A landed spring keeps its state this long, so a pause resumes at cruise. */
export const SETTLE_GRACE_MS = 500
/** Farther than this many viewports from the target, teleport first. */
export const GLIDE_MAX_VIEWPORTS = 2.5

export type Spring = {
  /** px per 60fps frame. */
  velocity: number
  /** Smoothed target growth, px per 60fps frame. */
  targetVelocity: number
  /** The target at the previous step; unset on a cold spring. */
  lastTarget?: number
}

export const restingSpring = (): Spring => ({ velocity: 0, targetVelocity: 0 })

/** Below the settle thresholds of use-stick-to-bottom. */
export const springIdle = (spring: Spring) =>
  spring.velocity < 0.05 && spring.targetVelocity < 0.05

/** Elapsed time in 60fps frames, capped so a hitch cannot teleport. */
export function framesSince(last: number | undefined, now: number) {
  if (last === undefined) return 1
  return Math.min(Math.max(0, now - last) / FRAME_MS, MAX_CATCHUP_FRAMES)
}

/**
 * One tick of the use-stick-to-bottom spring. `position` and `target` are
 * scroll offsets (larger = nearer the bottom). The chase point leads the
 * true bottom by up to 32px in proportion to growth, so a growing tail stays
 * visible instead of hugging a moving edge. The result never overshoots,
 * moves only toward the target, and snaps within 0.5px.
 */
export function stepSpring(
  spring: Spring,
  position: number,
  target: number,
  frames: number,
): { spring: Spring; position: number } {
  const grew = spring.lastTarget === undefined ? 0 : target - spring.lastTarget
  // A shrinking target (a fold or a removed row) makes the estimate stale.
  const targetVelocity =
    grew < -1
      ? 0
      : spring.targetVelocity +
        GROWTH_EMA *
          (Math.max(grew, 0) / Math.max(frames, 0.25) - spring.targetVelocity)
  const chase = target - Math.min(targetVelocity * 9, CHASE_MAX_LEAD)
  let velocity = spring.velocity
  let next = position
  for (let left = frames; left > 0; left -= 1) {
    const step = Math.min(left, 1)
    const pull = Math.max(chase - next, 0)
    velocity +=
      step *
      ((SPRING_DAMPING * velocity + SPRING_STIFFNESS * pull) / SPRING_MASS -
        velocity)
    next = Math.min(next + (velocity + targetVelocity) * step, target)
  }
  return {
    spring: { velocity, targetVelocity, lastTarget: target },
    position: target - next <= 0.5 ? target : next,
  }
}

/**
 * Where a glide starts: more than 2.5 viewports away, jump to 2.5 viewports
 * from the target first, so a long way back does not take seconds.
 */
export function glideStart(position: number, target: number, viewport: number) {
  const limit = GLIDE_MAX_VIEWPORTS * viewport
  if (viewport <= 0 || Math.abs(target - position) <= limit) return position
  return target > position ? target - limit : target + limit
}

/**
 * A fresh prompt rests where the first row of a chat rests: zeron parks it
 * 10px under its overlaid titlebar, which forge keeps outside the scroller.
 * The first row of a chat already carries that space.
 */
export const OWN_SEND_INSET = FIRST_ROW_GAP - ENTRY_GAP
/**
 * The runway ends 2px past the hold, so the held layout never becomes
 * shorter than the viewport. Two pixels of travel is below perception.
 */
export const RUNWAY_SLACK = 2
/** Each 60fps frame keeps 85% of the remaining glide: ~90% in ~230ms. */
export const RUNWAY_GLIDE_RETAIN = 0.85
export const RUNWAY_SNAP_PX = 1

export function runwayInset(promptIndex: number) {
  return promptIndex === 0 ? 0 : OWN_SEND_INSET
}

/** The scroll offset that rests the prompt `inset` below the viewport top. */
export function runwayHold(promptOffset: number, inset: number) {
  return promptOffset - inset
}

/**
 * The least content height that lets the prompt rest at its hold: the
 * reservation ends at the viewport bottom, plus the slack.
 */
export function runwayMinHeight(
  promptOffset: number,
  viewport: number,
  inset: number,
) {
  return runwayHold(promptOffset, inset) + viewport + RUNWAY_SLACK
}

/** The reply has outgrown the reservation; tail-follow takes over. */
export function runwayFilled(
  contentHeight: number,
  promptOffset: number,
  viewport: number,
  inset: number,
) {
  return contentHeight > runwayMinHeight(promptOffset, viewport, inset)
}

/** One frame of the runway's ease-out glide toward the hold. */
export function stepGlide(position: number, target: number, frames: number) {
  const error = target - position
  if (Math.abs(error) <= RUNWAY_SNAP_PX) return target
  return position + error * (1 - RUNWAY_GLIDE_RETAIN ** frames)
}

/**
 * The hold corrects only a view that drifted above it, or one sunk well
 * past the slack under it; resting inside the slack is legal.
 */
export function holdDrifted(position: number, hold: number) {
  return hold - position > 0.5 || position - hold > RUNWAY_SLACK + 2
}

/** The top fade band plus 28px: a revealed prompt reads below the fade. */
export const FOLD_TOP_BAND = 24 + 28
export const FOLD_BOTTOM_GAP = 12

/** A prompt folds in 220ms plus 0.32ms per pixel, at most 850ms. */
export function foldDuration(heightDelta: number) {
  return Math.min(220 + 0.32 * Math.max(0, heightDelta), 850)
}

/** Large folds ease in and out, so they do not vanish in a few frames. */
export function foldCurve(heightDelta: number) {
  return heightDelta > 500 ? easeInOut : easeOut
}

export function foldCurveCss(heightDelta: number) {
  return heightDelta > 500
    ? 'cubic-bezier(0.42, 0, 0.58, 1)'
    : 'cubic-bezier(0, 0, 0.58, 1)'
}

/**
 * Where a folding row's top should end, in viewport px: between 52px below
 * the top and far enough above the bottom that its new height fits.
 */
export function foldTargetTop({
  rowTop,
  viewportHeight,
  bottomInset,
  targetHeight,
}: {
  rowTop: number
  viewportHeight: number
  /** Overlaid chrome at the bottom, such as the composer. */
  bottomInset: number
  targetHeight: number
}) {
  const top = FOLD_TOP_BAND
  const bottom = viewportHeight - bottomInset - targetHeight - FOLD_BOTTOM_GAP
  if (bottom < top) return top
  return Math.min(Math.max(rowTop, top), bottom)
}

/** The row's top at `elapsed` ms into the fold, on the fold's own curve. */
export function foldTopAt(
  fold: { from: number; to: number; duration: number; heightDelta: number },
  elapsed: number,
) {
  const raw = fold.duration > 0 ? Math.min(1, elapsed / fold.duration) : 1
  return lerp(fold.from, fold.to, foldCurve(fold.heightDelta)(raw))
}
