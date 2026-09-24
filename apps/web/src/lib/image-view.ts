/**
 * Zoom and pan for the image lightbox, after zeron's image_viewer.rs. The
 * image starts fitted (never upscaled), zooms around the pointer, and pans
 * only as far as the image overflows the viewport.
 */
export type Size = { width: number; height: number }
export type Point = { x: number; y: number }
export type ImageGeometry = {
  natural: Size
  viewport: Size
  scale: number
  pan: Point
  /** Still at the fitted scale; a resize refits instead of clamping. */
  fitted: boolean
}

/** A pointer that moves this far is a drag, and its release does not close. */
export const DRAG_THRESHOLD = 4
/** One wheel line in pixels. */
const LINE_PX = 40

export const initialGeometry: ImageGeometry = {
  natural: { width: 1, height: 1 },
  viewport: { width: 1, height: 1 },
  scale: 1,
  pan: { x: 0, y: 0 },
  fitted: true,
}

export function fitScale(geometry: ImageGeometry) {
  return Math.min(
    geometry.viewport.width / geometry.natural.width,
    geometry.viewport.height / geometry.natural.height,
    1,
  )
}

function clampPan(geometry: ImageGeometry): ImageGeometry {
  const limitX = Math.max(
    0,
    (geometry.natural.width * geometry.scale - geometry.viewport.width) / 2,
  )
  const limitY = Math.max(
    0,
    (geometry.natural.height * geometry.scale - geometry.viewport.height) / 2,
  )
  return {
    ...geometry,
    pan: {
      x: Math.min(limitX, Math.max(-limitX, geometry.pan.x)),
      y: Math.min(limitY, Math.max(-limitY, geometry.pan.y)),
    },
  }
}

const positive = (value: number) => Number.isFinite(value) && value > 0

/** New image or viewport size. A fitted image refits; a zoomed one clamps. */
export function resize(
  geometry: ImageGeometry,
  natural: Size,
  viewport: Size,
): ImageGeometry {
  if (
    ![natural.width, natural.height, viewport.width, viewport.height].every(
      positive,
    )
  )
    return geometry
  const next = { ...geometry, natural, viewport }
  if (!next.fitted) return clampPan(next)
  return { ...next, scale: fitScale(next), pan: { x: 0, y: 0 } }
}

/** Zoom to `scale`, keeping the image point under `anchor` still. */
export function zoom(
  geometry: ImageGeometry,
  scale: number,
  anchor: Point,
): ImageGeometry {
  if (
    !positive(scale) ||
    !Number.isFinite(anchor.x) ||
    !Number.isFinite(anchor.y)
  )
    return geometry
  const fit = fitScale(geometry)
  const maximum = Math.max(
    Math.min(
      131072 / Math.max(geometry.natural.width, geometry.natural.height),
      32,
    ),
    fit,
  )
  const next = Math.min(maximum, Math.max(Math.min(fit, 0.01), scale))
  const ratio = next / geometry.scale
  const x = anchor.x - geometry.viewport.width / 2
  const y = anchor.y - geometry.viewport.height / 2
  return clampPan({
    ...geometry,
    scale: next,
    fitted: false,
    pan: {
      x: x - (x - geometry.pan.x) * ratio,
      y: y - (y - geometry.pan.y) * ratio,
    },
  })
}

export function panBy(geometry: ImageGeometry, delta: Point): ImageGeometry {
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return geometry
  return clampPan({
    ...geometry,
    pan: { x: geometry.pan.x + delta.x, y: geometry.pan.y + delta.y },
  })
}

/** Top-left of the drawn image inside the viewport. */
export function imageOrigin(geometry: ImageGeometry): Point {
  return {
    x:
      (geometry.viewport.width - geometry.natural.width * geometry.scale) / 2 +
      geometry.pan.x,
    y:
      (geometry.viewport.height - geometry.natural.height * geometry.scale) /
        2 +
      geometry.pan.y,
  }
}

/**
 * A wheel event: Ctrl (and trackpad pinch, which browsers report as
 * Ctrl+wheel) zooms around the pointer; a plain wheel pans.
 */
export function wheel(
  geometry: ImageGeometry,
  event: {
    deltaX: number
    deltaY: number
    /** 1 when the deltas count lines. */
    deltaMode: number
    ctrlKey: boolean
  },
  anchor: Point,
): ImageGeometry {
  const unit = event.deltaMode === 1 ? LINE_PX : 1
  const dx = event.deltaX * unit
  const dy = event.deltaY * unit
  if (event.ctrlKey) {
    const factor = Math.exp(Math.min(2, Math.max(-2, -dy * 0.0025)))
    return zoom(geometry, geometry.scale * factor, anchor)
  }
  return panBy(geometry, { x: -dx, y: -dy })
}
