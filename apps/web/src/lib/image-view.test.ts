import { describe, expect, it } from 'vitest'
import {
  imageOrigin,
  initialGeometry,
  panBy,
  resize,
  wheel,
  zoom,
} from './image-view'

const fitted = () =>
  resize(
    initialGeometry,
    { width: 1000, height: 500 },
    { width: 500, height: 400 },
  )

describe('image view geometry', () => {
  it('fits while keeping the aspect ratio and never upscales', () => {
    const geometry = fitted()
    expect(geometry.scale).toBe(0.5)
    expect(imageOrigin(geometry)).toEqual({ x: 0, y: 75 })
    const small = resize(
      initialGeometry,
      { width: 100, height: 50 },
      { width: 500, height: 400 },
    )
    expect(small.scale).toBe(1)
  })

  it('keeps the point under the pointer still while zooming', () => {
    const geometry = fitted()
    const anchor = { x: 400, y: 200 }
    const before = imageOrigin(geometry)
    const imagePoint = (anchor.x - before.x) / geometry.scale
    const zoomed = zoom(geometry, 1, anchor)
    const after = imageOrigin(zoomed)
    expect((anchor.x - after.x) / zoomed.scale).toBeCloseTo(imagePoint)
    expect(zoomed.fitted).toBe(false)
  })

  it('bounds zoom and pan, and ignores bad input', () => {
    const geometry = fitted()
    expect(zoom(geometry, 1e9, { x: 250, y: 150 }).scale).toBe(32)
    expect(zoom(geometry, 1e-9, { x: 250, y: 150 }).scale).toBe(0.01)
    expect(zoom(geometry, Number.NaN, { x: 0, y: 0 })).toBe(geometry)
    // A fitted image has no overflow to pan into.
    expect(panBy(geometry, { x: 50, y: 50 }).pan).toEqual({ x: 0, y: 0 })
    const zoomed = zoom(geometry, 1, { x: 250, y: 200 })
    expect(panBy(zoomed, { x: 10_000, y: 0 }).pan.x).toBe(250)
  })

  it('refits on resize until the user zooms', () => {
    const geometry = resize(
      fitted(),
      { width: 1000, height: 500 },
      { width: 250, height: 400 },
    )
    expect(geometry.scale).toBe(0.25)
    const zoomed = zoom(geometry, 1, { x: 125, y: 200 })
    expect(
      resize(zoomed, { width: 1000, height: 500 }, { width: 500, height: 400 })
        .scale,
    ).toBe(1)
  })

  it('zooms on Ctrl+wheel and pans on a plain wheel', () => {
    const geometry = zoom(fitted(), 1, { x: 250, y: 200 })
    const up = wheel(
      geometry,
      { deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: true },
      { x: 250, y: 200 },
    )
    expect(up.scale).toBeGreaterThan(geometry.scale)
    const down = wheel(
      geometry,
      { deltaX: 0, deltaY: 100, deltaMode: 0, ctrlKey: true },
      { x: 250, y: 200 },
    )
    expect(down.scale).toBeLessThan(geometry.scale)
    const panned = wheel(
      geometry,
      { deltaX: 0, deltaY: 1, deltaMode: 1, ctrlKey: false },
      { x: 0, y: 0 },
    )
    expect(panned.pan.y).toBe(geometry.pan.y - 40)
  })
})
