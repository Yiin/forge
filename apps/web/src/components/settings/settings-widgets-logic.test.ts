import { describe, expect, it } from 'vitest'
import {
  clampPercent,
  formatResetText,
  usageMeterTone,
} from './settings-widgets-logic'

describe('usageMeterTone', () => {
  it('switches to warning at 80% and critical at 95%', () => {
    expect(usageMeterTone(0)).toBe('normal')
    expect(usageMeterTone(79.9)).toBe('normal')
    expect(usageMeterTone(80)).toBe('warning')
    expect(usageMeterTone(94.9)).toBe('warning')
    expect(usageMeterTone(95)).toBe('critical')
    expect(usageMeterTone(140)).toBe('critical')
  })
})

describe('clampPercent', () => {
  it('keeps values inside 0..100', () => {
    expect(clampPercent(-5)).toBe(0)
    expect(clampPercent(42)).toBe(42)
    expect(clampPercent(120)).toBe(100)
    expect(clampPercent(Number.NaN)).toBe(0)
  })
})

describe('formatResetText', () => {
  // Local-time constructors keep the expectations independent of TZ.
  const now = new Date(2026, 8, 1, 9, 0).getTime()
  const at = (...parts: [number, number, number, number, number]) =>
    new Date(...parts).toISOString()

  it('shows the clock time under 22 hours', () => {
    expect(formatResetText(at(2026, 8, 1, 15, 45), now, 'en-US')).toBe(
      'resets 3:45 PM',
    )
    expect(formatResetText(at(2026, 8, 2, 6, 59), now, 'en-US')).toBe(
      'resets 6:59 AM',
    )
  })

  it('shows the weekday from 22 hours up to 7 days', () => {
    expect(formatResetText(at(2026, 8, 2, 7, 0), now, 'en-US')).toBe(
      'resets Wed',
    )
    expect(formatResetText(at(2026, 8, 7, 12, 0), now, 'en-US')).toBe(
      'resets Mon',
    )
  })

  it('shows the date from 7 days on', () => {
    expect(formatResetText(at(2026, 8, 14, 12, 0), now, 'en-US')).toBe(
      'resets Sep 14',
    )
  })

  it('returns null for past or invalid reset times', () => {
    expect(formatResetText(at(2026, 8, 1, 8, 0), now, 'en-US')).toBeNull()
    expect(formatResetText('not a date', now, 'en-US')).toBeNull()
  })
})
