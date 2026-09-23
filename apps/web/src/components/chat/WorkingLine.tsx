import { useEffect, useMemo, useState } from 'react'
import { cn } from '../../lib/utils'
import {
  flavourWord,
  fnv1a,
  formatElapsed,
  type WorkingPhase,
} from './transcript-layout'
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
 * counted and then reset. A prompt held for the connection reads
 * "Queued, will send automatically"; one that never reached the server
 * while the connection is up turns the line into a retry link.
 */
export function WorkingLine({
  seed,
  phase,
  startedAt,
  onRetry,
}: {
  /** The session id; each chat gets its own word order. */
  seed: string
  phase: WorkingPhase
  /** When the running turn started, as an ISO time. */
  startedAt?: string
  onRetry?: () => void
}) {
  const [mountedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  const timed = phase === 'working'
  useEffect(() => {
    if (!timed) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [timed])
  const hash = useMemo(() => fnv1a(seed), [seed])
  if (phase === 'undelivered')
    return (
      <div
        className="chat-working flex items-center gap-2"
        role="status"
        aria-live="polite"
      >
        <button
          type="button"
          className="cursor-pointer rounded-sm text-xs leading-[18px] text-destructive hover:underline focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none pointer-coarse:min-h-11"
          onClick={onRetry}
        >
          Not delivered, click to retry
        </button>
      </div>
    )
  const start = startedAt ? Date.parse(startedAt) : mountedAt
  const elapsed = Math.max(
    0,
    (now - (Number.isNaN(start) ? mountedAt : start)) / 1000,
  )
  const label =
    phase === 'queued'
      ? 'Queued, will send automatically'
      : phase === 'sending'
        ? 'Sending…'
        : `${flavourWord(hash, elapsed)}…`
  return (
    <div
      className="chat-working flex items-center gap-2 text-[11px]"
      role="status"
      aria-live="polite"
    >
      <GradientSpinner />
      {/* The word changes every 7 seconds; announce the state only once. */}
      <span className="sr-only">{SPOKEN[phase]}</span>
      <span
        className={cn(
          'text-xs leading-[18px]',
          phase === 'queued' ? 'text-warning' : 'text-muted-foreground',
        )}
        aria-hidden
      >
        {label}
      </span>
      {timed && (
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

const SPOKEN = {
  working: 'Working',
  sending: 'Sending',
  queued: 'Queued, will send automatically',
} as const
