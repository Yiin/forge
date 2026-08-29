import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover'
import type { HarnessAccountSnapshot } from '@/lib/accounts-api'
import {
  deriveContextWindowView,
  formatContextWindowTokens,
} from '@/lib/context-window'
import type { ContextWindowUsage } from '@forge/protocol/events'

const asPercent = (value: number) =>
  Math.round(value <= 1 ? value * 100 : value)
const resetText = (value: string) => {
  const minutes = Math.max(
    0,
    Math.floor((Date.parse(value) - Date.now()) / 60_000),
  )
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h` : `${minutes}m`
}

export function ContextWindowMeter({
  usage,
  account,
}: {
  usage: ContextWindowUsage
  account?: HarnessAccountSnapshot
}) {
  const view = deriveContextWindowView(usage)
  const displayPercent =
    view.usedPercentage === null ? null : Math.round(view.usedPercentage)
  const ringPercent = Math.max(0, Math.min(100, view.usedPercentage ?? 0))
  const radius = 9.75
  const circumference = 2 * Math.PI * radius
  const color =
    ringPercent > 90 ? 'var(--color-red-500)' : 'var(--color-blue-500)'
  const statusLine =
    account?.usageStatus === 'auth'
      ? 'Sign in to view usage.'
      : account?.usageStatus === 'unavailable'
        ? 'Provider unavailable. Last known windows shown.'
        : null
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        render={
          <button
            type="button"
            className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full border border-transparent hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            aria-label={
              displayPercent === null
                ? `Context window ${formatContextWindowTokens(view.usedTokens)} tokens used`
                : `Context window ${displayPercent}% used`
            }
          />
        }
      >
        <svg
          viewBox="0 0 24 24"
          className="size-4 -rotate-90"
          aria-hidden="true"
        >
          <circle
            cx="12"
            cy="12"
            r={radius}
            fill="none"
            stroke="var(--color-muted-foreground)"
            strokeOpacity=".35"
            strokeWidth="3"
          />
          <circle
            cx="12"
            cy="12"
            r={radius}
            fill="none"
            stroke={
              view.usedPercentage === null
                ? 'var(--color-muted-foreground)'
                : color
            }
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - ringPercent / 100)}
            className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
          />
        </svg>
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" className="w-64 max-w-none p-0">
        <div className="flex flex-col gap-2 p-3 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-muted-foreground">
              Context Window
            </span>
            {account?.tierLabel && (
              <span className="text-muted-foreground/70">
                {account.tierLabel}
              </span>
            )}
            <span className="text-[11px] tabular-nums text-muted-foreground/70">
              {displayPercent === null
                ? formatContextWindowTokens(view.usedTokens)
                : `${displayPercent}% · ${formatContextWindowTokens(view.usedTokens)}/${formatContextWindowTokens(view.maxTokens ?? null)}`}
            </span>
          </div>
          {view.maxTokens !== undefined && (
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={displayPercent ?? 0}
              aria-label="Context window usage"
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
            >
              <div
                className="h-full rounded-full"
                style={{ width: `${ringPercent}%`, backgroundColor: color }}
              />
            </div>
          )}
          {(view.totalProcessedTokens ?? 0) > 0 && (
            <div className="flex justify-between text-muted-foreground">
              <span>Total processed</span>
              <span>
                {formatContextWindowTokens(view.totalProcessedTokens ?? null)}
              </span>
            </div>
          )}
          {view.compactsAutomatically && (
            <div className="text-muted-foreground/70">
              This harness automatically compacts its context when needed.
            </div>
          )}
          {account?.usageStatus !== 'unsupported' && account && (
            <div className="mt-1 border-t pt-2">
              {statusLine ? (
                <div className="text-muted-foreground">{statusLine}</div>
              ) : (
                account.usage?.map((window, index) => (
                  <div
                    key={window.windowId ?? `${window.window}-${index}`}
                    className="flex justify-between gap-3"
                  >
                    <span>{window.window}</span>
                    <span>
                      {asPercent(window.utilization)}%
                      {window.resetsAt
                        ? ` · resets in ${resetText(window.resetsAt)}`
                        : ''}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  )
}
