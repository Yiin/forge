import type { CSSProperties, ReactNode } from 'react'
export function Sidebar({
  children,
  width,
  open = true,
  onResize,
}: {
  children: ReactNode
  width: number
  open?: boolean
  onResize: (width: number) => void
}) {
  return (
    <aside
      className={`sidebar ${open ? '' : 'sidebar-collapsed'}`}
      style={{ '--sidebar-width': `${width}px` } as CSSProperties}
    >
      <div className="sidebar-content">{children}</div>
      <div
        className="resize-handle"
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuenow={width}
        aria-valuemin={216}
        aria-valuemax={360}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          onResize(width + (event.key === 'ArrowRight' ? 16 : -16))
        }}
        onPointerDown={(event) => {
          const start = event.clientX
          const initial = width
          const move = (e: PointerEvent) =>
            onResize(initial + e.clientX - start)
          const stop = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', stop)
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', stop)
        }}
      />
    </aside>
  )
}
