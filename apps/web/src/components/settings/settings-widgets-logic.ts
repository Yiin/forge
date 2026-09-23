export type UsageMeterTone = 'normal' | 'warning' | 'critical'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** Clamps a usage percentage to 0..100 and drops non-finite input to 0. */
export function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0
  return Math.min(100, Math.max(0, percent))
}

/** Meter color: warning from 80% used, critical from 95% used. */
export function usageMeterTone(percent: number): UsageMeterTone {
  const value = clampPercent(percent)
  if (value >= 95) return 'critical'
  if (value >= 80) return 'warning'
  return 'normal'
}

/**
 * Short reset label for a usage window: the clock time when the reset is
 * under 22 hours away, the weekday under 7 days, otherwise the date.
 * Returns null for an unparseable or past reset time.
 */
export function formatResetText(
  resetsAt: string,
  nowMs: number,
  locale?: string,
): string | null {
  const at = Date.parse(resetsAt)
  const remaining = at - nowMs
  if (!Number.isFinite(remaining) || remaining <= 0) return null
  const options: Intl.DateTimeFormatOptions =
    remaining < 22 * HOUR_MS
      ? { hour: 'numeric', minute: '2-digit' }
      : remaining < 7 * DAY_MS
        ? { weekday: 'short' }
        : { month: 'short', day: 'numeric' }
  return `resets ${new Intl.DateTimeFormat(locale, options).format(at)}`
}
