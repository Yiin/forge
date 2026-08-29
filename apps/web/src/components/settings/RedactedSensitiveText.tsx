import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

function redactedPlaceholder(value: string) {
  let state = 0x811c9dc5
  for (const character of value) {
    state ^= character.charCodeAt(0)
    state = Math.imul(state, 0x01000193)
  }
  return Array.from(value, (character) => {
    if ('@.-_'.includes(character)) return character
    state = Math.imul(state ^ (state >>> 13), 0x85ebca6b)
    state = Math.imul(state ^ (state >>> 16), 0xc2b2ae35)
    return ALPHABET[Math.abs(state) % ALPHABET.length] ?? 'x'
  }).join('')
}

export function RedactedSensitiveText({
  value,
  ariaLabel,
  revealTooltip,
  hideTooltip,
  className,
}: {
  value: string | null | undefined
  ariaLabel: string
  revealTooltip: string
  hideTooltip: string
  className?: string
}) {
  const [revealed, setRevealed] = useState(false)
  const trimmed = value?.trim()
  const redacted = useMemo(
    () => (trimmed ? redactedPlaceholder(trimmed) : ''),
    [trimmed],
  )
  if (!trimmed) return null
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              'min-w-0 cursor-pointer rounded-sm font-mono text-[11px] leading-none transition hover:text-foreground',
              revealed
                ? 'text-muted-foreground'
                : 'select-none text-muted-foreground blur-[2px]',
              className,
            )}
            onClick={() => setRevealed((current) => !current)}
            aria-label={ariaLabel}
          />
        }
      >
        {revealed ? trimmed : redacted}
      </TooltipTrigger>
      <TooltipContent side="top">
        {revealed ? hideTooltip : revealTooltip}
      </TooltipContent>
    </Tooltip>
  )
}
