import { useEffect, useMemo, useState } from 'react'
import { flavourWord, fnv1a, formatElapsed } from './transcript-layout'
import './transcript.css'

// Each dot's phase: the wave runs from the bottom edge up to the top middle.
const OFFSETS = [
  [0.25, 0, 0.25],
  [0.5, 0.25, 0.5],
  [0.75, 0.5, 0.75],
]

/** zeron's 3x3 working matrix: 2.5px dots, three fixed row tints. */
export function GradientSpinner() {
  return (
    <span className="gradient-spinner" aria-hidden>
      {OFFSETS.flatMap((row, rowIndex) =>
        row.map((offset, column) => (
          <span
            key={`${rowIndex}-${column}`}
            data-row={rowIndex}
            style={{ ['--offset' as string]: offset }}
          />
        )),
      )}
    </span>
  )
}

/**
 * The in-transcript working line: the matrix spinner, a flavour word that
 * changes every 7 seconds, and the turn's elapsed time. Until the turn
 * starts it reads "Sending…" with no timer, so the round trip is not
 * counted and then reset.
 */
export function WorkingLine({
  seed,
  sending,
  startedAt,
}: {
  /** The session id; each chat gets its own word order. */
  seed: string
  sending: boolean
  /** When the running turn started, as an ISO time. */
  startedAt?: string
}) {
  const [mountedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (sending) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [sending])
  const hash = useMemo(() => fnv1a(seed), [seed])
  const start = startedAt ? Date.parse(startedAt) : mountedAt
  const elapsed = Math.max(
    0,
    (now - (Number.isNaN(start) ? mountedAt : start)) / 1000,
  )
  return (
    <div
      className="chat-working flex items-center gap-2 text-[11px]"
      role="status"
      aria-live="polite"
    >
      <GradientSpinner />
      {/* The word changes every 7 seconds; announce the state only once. */}
      <span className="sr-only">{sending ? 'Sending' : 'Working'}</span>
      <span
        className="text-xs leading-[18px] text-muted-foreground"
        aria-hidden
      >
        {sending ? 'Sending…' : `${flavourWord(hash, elapsed)}…`}
      </span>
      {!sending && (
        <span
          className="relative top-px text-faint-foreground tabular-nums"
          aria-hidden
        >
          {formatElapsed(elapsed)}
        </span>
      )}
    </div>
  )
}
