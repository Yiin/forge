import { describe, expect, it } from 'vitest'
import {
  chipHandoff,
  collapseProgress,
  COLLAPSE_MS,
  CROSSFADE_MS,
  DOCK_MS,
  dockFrame,
  dockSpring,
  pillOffset,
  smoothstep,
} from './composer-motion'

describe('dock spring', () => {
  it('rises without overshoot and lands at the duration', () => {
    let previous = 0
    for (let elapsed = 0; elapsed <= DOCK_MS; elapsed += 10) {
      const value = dockSpring(elapsed)
      expect(value).toBeGreaterThanOrEqual(previous)
      expect(value).toBeLessThanOrEqual(1)
      previous = value
    }
    expect(dockSpring(0)).toBe(0)
    expect(dockSpring(DOCK_MS - 1)).toBeGreaterThan(0.999)
    expect(dockSpring(DOCK_MS)).toBe(1)
  })
})

describe('dock frame', () => {
  it('stages the fades on the clock (zeron composer_dock.rs)', () => {
    const at = (fraction: number) => dockFrame(DOCK_MS * fraction)
    expect(at(0)).toMatchObject({
      travel: 0,
      radius: 26,
      heroChrome: 1,
      footer: 0,
      transcript: 0,
      transcriptShift: 8,
      done: false,
    })
    expect(at(0.25).heroChrome).toBe(0)
    expect(at(0.25).footer).toBe(0)
    expect(at(0.2).transcript).toBe(0)
    expect(at(0.55).footer).toBe(1)
    expect(at(0.65).transcript).toBe(1)
    expect(at(0.65).transcriptShift).toBe(0)
    expect(at(1)).toMatchObject({ done: true, travel: 1, radius: 22 })
  })

  it('crossfades in place when motion is reduced', () => {
    const start = dockFrame(0, true)
    expect(start).toMatchObject({ travel: 1, radius: 22, footer: 0 })
    expect(start.heroChrome).toBe(1)
    const end = dockFrame(CROSSFADE_MS, true)
    expect(end).toMatchObject({ done: true, footer: 1, heroChrome: 0 })
  })
})

describe('flip morph', () => {
  it('eases out over the collapse duration', () => {
    expect(collapseProgress(0)).toBe(0)
    expect(collapseProgress(COLLAPSE_MS / 2)).toBeGreaterThan(0.5)
    expect(collapseProgress(COLLAPSE_MS)).toBe(1)
  })

  it('hides the chip past the midpoint, then fades it in with a drift', () => {
    expect(chipHandoff(0.3, true)).toEqual({ opacity: 0, drift: 6 })
    expect(chipHandoff(0.56, false)).toEqual({ opacity: 0, drift: -6 })
    const end = chipHandoff(1, true)
    expect(end.opacity).toBeCloseTo(1)
    expect(end.drift).toBeCloseTo(0)
  })
})

describe('helpers', () => {
  it('smoothsteps between edges and offsets the pill toward its target', () => {
    expect(smoothstep(0.2, 0.6, 0.1)).toBe(0)
    expect(smoothstep(0.2, 0.6, 0.4)).toBeCloseTo(0.5)
    expect(smoothstep(0.2, 0.6, 0.9)).toBe(1)
    expect(pillOffset({ x: 10, y: -300 }, { x: 0, y: 0 }, 0.5)).toEqual({
      x: 5,
      y: -150,
    })
  })
})
