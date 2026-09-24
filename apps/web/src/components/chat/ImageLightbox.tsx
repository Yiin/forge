import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import {
  DRAG_THRESHOLD,
  imageOrigin,
  initialGeometry,
  panBy,
  resize,
  wheel,
  zoom,
  type ImageGeometry,
  type Point,
} from '../../lib/image-view'

/**
 * zeron's attachment lightbox (attachments.rs:934-1031): the image over a
 * dim scrim, 90vw by 85vh, with its file name under it. Ctrl+wheel or a
 * pinch zooms, a drag or a plain wheel pans. Esc or a click that was not a
 * drag closes it, and focus goes back to `finalFocus`.
 */
export function ImageLightbox({
  src,
  name,
  onClose,
  finalFocus,
}: {
  /** The image to show; the lightbox is open while this is set. */
  src: string | null
  name: string
  onClose: () => void
  finalFocus?: RefObject<HTMLElement | null>
}) {
  const dragged = useRef(false)
  return (
    <DialogPrimitive.Root
      open={src !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/37 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 dark:bg-black/70" />
        <DialogPrimitive.Popup
          finalFocus={finalFocus}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 outline-none transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0"
          onClick={() => {
            if (dragged.current) dragged.current = false
            else onClose()
          }}
        >
          {src && (
            <ImageView key={src} src={src} name={name} dragged={dragged} />
          )}
          <DialogPrimitive.Title className="max-w-[90vw] truncate text-[11px] font-normal text-ink/45">
            {name}
          </DialogPrimitive.Title>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function ImageView({
  src,
  name,
  dragged,
}: {
  src: string
  name: string
  dragged: RefObject<boolean>
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const [geometry, setGeometry] = useState<ImageGeometry>(initialGeometry)
  const [loaded, setLoaded] = useState(false)
  const natural = useRef({ width: 0, height: 0 })
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef<{
    start: Point
    pan: Point
    scale: number
    spread?: number
  }>(undefined)

  const local = (event: { clientX: number; clientY: number }): Point => {
    const box = viewport.current!.getBoundingClientRect()
    return { x: event.clientX - box.left, y: event.clientY - box.top }
  }
  const fit = () => {
    const box = viewport.current
    if (!box || !natural.current.width) return
    setGeometry((current) =>
      resize(current, natural.current, {
        width: box.clientWidth,
        height: box.clientHeight,
      }),
    )
  }

  useEffect(() => {
    const box = viewport.current
    if (!box) return
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(fit)
    observer?.observe(box)
    // The wheel must not scroll the page under the scrim.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const anchor = local(event)
      setGeometry((current) => wheel(current, event, anchor))
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      observer?.disconnect()
      box.removeEventListener('wheel', onWheel)
    }
  }, [])

  const spread = () => {
    const [a, b] = [...pointers.current.values()]
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
  }
  const middle = (): Point => {
    const [a, b] = [...pointers.current.values()]
    return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : { x: 0, y: 0 }
  }
  const origin = imageOrigin(geometry)
  return (
    <div
      ref={viewport}
      className="relative h-[85vh] w-[90vw] touch-none overflow-hidden select-none"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.currentTarget.setPointerCapture?.(event.pointerId)
        pointers.current.set(event.pointerId, local(event))
        dragged.current = false
        gesture.current = {
          start: pointers.current.size > 1 ? middle() : local(event),
          pan: geometry.pan,
          scale: geometry.scale,
          spread: pointers.current.size > 1 ? spread() : undefined,
        }
      }}
      onPointerMove={(event) => {
        const start = gesture.current
        if (!start || !pointers.current.has(event.pointerId)) return
        pointers.current.set(event.pointerId, local(event))
        if (start.spread) {
          dragged.current = true
          const scale = (start.scale * spread()) / start.spread
          const anchor = middle()
          setGeometry((current) => zoom(current, scale, anchor))
          return
        }
        const point = local(event)
        const delta = { x: point.x - start.start.x, y: point.y - start.start.y }
        if (Math.hypot(delta.x, delta.y) >= DRAG_THRESHOLD)
          dragged.current = true
        if (!dragged.current) return
        setGeometry((current) => panBy({ ...current, pan: start.pan }, delta))
      }}
      onPointerUp={(event) => {
        pointers.current.delete(event.pointerId)
        gesture.current = undefined
      }}
      onPointerCancel={(event) => {
        pointers.current.delete(event.pointerId)
        gesture.current = undefined
      }}
    >
      {!loaded && (
        <p className="absolute inset-0 grid place-items-center text-[13px] text-ink/60">
          Loading image…
        </p>
      )}
      <img
        src={src}
        alt={name}
        draggable={false}
        onLoad={(event) => {
          natural.current = {
            width: event.currentTarget.naturalWidth,
            height: event.currentTarget.naturalHeight,
          }
          setLoaded(true)
          fit()
        }}
        className="absolute max-w-none"
        style={{
          left: origin.x,
          top: origin.y,
          width: geometry.natural.width * geometry.scale,
          height: geometry.natural.height * geometry.scale,
          visibility: loaded ? 'visible' : 'hidden',
        }}
      />
    </div>
  )
}
