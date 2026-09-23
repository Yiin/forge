import { useEffect, useState } from 'react'

/**
 * A user's open/closed choice for a transcript disclosure, kept by row id so
 * it survives virtualization unmounting the row while it scrolls away.
 * `undefined` means the user has not chosen, and the caller's default wins.
 */
const pins = new Map<string, boolean>()

export function usePinnedDisclosure(id: string) {
  const [pin, setPin] = useState(() => pins.get(id))
  const update = (open: boolean) => {
    pins.set(id, open)
    setPin(open)
  }
  return [pin, update] as const
}

/**
 * Keeps a folding body mounted through its close tween, then drops it, so a
 * closed group costs nothing in the DOM.
 */
export function useFoldMount(open: boolean, durationMs = 140) {
  const [mounted, setMounted] = useState(open)
  const [expanded, setExpanded] = useState(open)
  useEffect(() => {
    if (open) {
      setMounted(true)
      // Mount at 0fr first so the grid track has a start value to tween from.
      const frame = requestAnimationFrame(() => setExpanded(true))
      return () => cancelAnimationFrame(frame)
    }
    setExpanded(false)
    const timer = setTimeout(() => setMounted(false), durationMs)
    return () => clearTimeout(timer)
  }, [open, durationMs])
  return { mounted: mounted || open, expanded: expanded && open }
}
