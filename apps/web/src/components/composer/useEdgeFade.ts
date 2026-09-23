import { useEffect, useRef } from 'react'

/**
 * Fades a scroll container's edges only on the side that overflows. Pair the
 * element with EDGE_FADE_CLASS; this hook sets its --fade-top/--fade-bottom.
 */
export function useEdgeFade<T extends HTMLElement>(band = 12) {
  const ref = useRef<T>(null)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const update = () => {
      const top = node.scrollTop > 0
      const bottom = node.scrollTop + node.clientHeight < node.scrollHeight - 1
      node.style.setProperty('--fade-top', top ? `${band}px` : '0px')
      node.style.setProperty('--fade-bottom', bottom ? `${band}px` : '0px')
    }
    update()
    node.addEventListener('scroll', update, { passive: true })
    const resize =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(update)
    resize?.observe(node)
    const mutation =
      typeof MutationObserver === 'undefined'
        ? undefined
        : new MutationObserver(update)
    mutation?.observe(node, { childList: true, subtree: true })
    return () => {
      node.removeEventListener('scroll', update)
      resize?.disconnect()
      mutation?.disconnect()
    }
  }, [band])
  return ref
}

/** Mask driven by useEdgeFade's custom properties. */
export const EDGE_FADE_CLASS =
  '[mask-image:linear-gradient(to_bottom,transparent,#000_var(--fade-top,0px),#000_calc(100%-var(--fade-bottom,0px)),transparent)]'
