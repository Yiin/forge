/** zeron's motion curves (crates/ui/src/motion.rs) and small helpers. */

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

/** Height and width changes. */
export const easeOut = cubicBezier(0, 0, 0.58, 1)
/** Scroll glides. */
export const easeInOut = cubicBezier(0.42, 0, 0.58, 1)
/** Entrances. */
export const easeOutExpo = cubicBezier(0.16, 1, 0.3, 1)
/** The tool connector draw. */
export const easeOutQuint = cubicBezier(0.22, 1, 0.36, 1)

export const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

export const lerp = (from: number, to: number, progress: number) =>
  from + (to - from) * progress

export function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  )
}
