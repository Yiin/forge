import { describe, expect, it } from 'vitest'
import { cubicBezier, easeInOut, easeOutQuint, lerp } from './motion'

describe('motion curves', () => {
  it('eases like the CSS curve', () => {
    expect(easeInOut(0)).toBe(0)
    expect(easeInOut(1)).toBe(1)
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 5)
    // The first 16ms frame of a 500ms glide moves less than 2%.
    expect(easeInOut(16 / 500)).toBeLessThan(0.02)
    expect(cubicBezier(0, 0, 1, 1)(0.3)).toBeCloseTo(0.3, 5)
    // Quint-out is most of the way there by half time.
    expect(easeOutQuint(0.5)).toBeGreaterThan(0.9)
    expect(lerp(10, 20, 0.25)).toBe(12.5)
  })
})
