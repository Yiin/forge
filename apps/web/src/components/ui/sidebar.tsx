import type { CSSProperties, ReactNode } from 'react'
export function Sidebar({
  children,
  width,
  onResize,
}: {
  children: ReactNode
  width: number
  onResize: (width: number) => void
}) {
  return (
    <aside
      className="sidebar"
      style={{ '--sidebar-width': `${width}px` } as CSSProperties}
    >
      <div className="sidebar-content">{children}</div>
      <div
        className="resize-handle"
        role="separator"
        aria-label="Resize sidebar"
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
