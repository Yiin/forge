import { useEffect, useRef, useState } from 'react'

/** zeron shows a check for 1200ms after a copy. */
export const COPIED_MS = 1200

/** Copy text to the clipboard and report it as copied for a moment. */
export function useCopied() {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), COPIED_MS)
    })
  }
  return [copied, copy] as const
}
