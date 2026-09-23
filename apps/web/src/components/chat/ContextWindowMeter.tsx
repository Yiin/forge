import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { CARD_CLASS, CARD_VIEWPORT_CLASS } from '../composer/zeron-styles'
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
  const radius = 6
  const circumference = 2 * Math.PI * radius
  // zeron context_usage.rs: danger from 90%, warning from 75%, else muted.
  const tone =
    displayPercent === null
      ? 'text-faint-foreground'
      : ringPercent >= 90
        ? 'text-destructive'
        : ringPercent >= 75
          ? 'text-warning'
          : 'text-muted-foreground'
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
            className={cn(
              'relative inline-flex h-6 shrink-0 cursor-pointer items-center gap-[5px] rounded-[6px] px-1.5 text-[11px] tabular-nums outline-none transition-colors duration-150 hover:bg-ink/5 focus-visible:bg-ink/5 data-popup-open:bg-ink/5 pointer-coarse:after:absolute pointer-coarse:after:-inset-2.5 pointer-coarse:after:content-[""]',
              tone,
            )}
            aria-label={
              displayPercent === null
                ? `Context window ${formatContextWindowTokens(view.usedTokens)} tokens used`
                : `Context window ${displayPercent}% used`
            }
          />
        }
      >
        <svg
          viewBox="0 0 16 16"
          className="size-4 -rotate-90"
          aria-hidden="true"
        >
          <circle
            cx="8"
            cy="8"
            r={radius}
            fill="none"
            stroke="var(--color-faint-foreground)"
            strokeOpacity=".25"
            strokeWidth="1.8"
          />
          <circle
            cx="8"
            cy="8"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - ringPercent / 100)}
            className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
          />
        </svg>
        <span aria-hidden="true">
          {displayPercent === null
            ? formatContextWindowTokens(view.usedTokens)
            : `${displayPercent}%`}
        </span>
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="end"
        sideOffset={6}
        className={cn(CARD_CLASS, 'w-64 max-w-none p-0')}
        viewportClassName={CARD_VIEWPORT_CLASS}
      >
        <div className="flex flex-col gap-2 p-2 text-[12px] leading-[19px]">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-foreground">Context window</span>
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
              className={cn(
                'h-1.5 w-full overflow-hidden rounded-full bg-ink/8',
                tone,
              )}
            >
              <div
                className="h-full rounded-full bg-current"
                style={{ width: `${ringPercent}%` }}
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
