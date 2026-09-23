import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Undo2Icon,
  XIcon,
} from 'lucide-react'
import {
  Children,
  Fragment,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useShellStore } from '../../stores/shell'
import {
  clampPercent,
  formatResetText,
  usageMeterTone,
} from './settings-widgets-logic'

export function ErrorRow({
  children,
  onRetry,
}: {
  children: ReactNode
  onRetry?: () => void
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 text-sm text-destructive"
      role="alert"
    >
      <AlertCircle className="size-4 shrink-0" />
      <span>{children}</span>
      {onRetry && (
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-destructive"
          onClick={onRetry}
        >
          Retry
        </Button>
      )}
    </div>
  )
}

export function RequestState({
  state,
  error,
  onRetry,
}: {
  state: 'loading' | 'saving' | 'saved' | 'error'
  error?: string | null
  onRetry?: () => void
}) {
  if (state === 'loading')
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (state === 'saving')
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Saving…
      </p>
    )
  if (state === 'saved')
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Saved.
      </p>
    )
  return (
    <ErrorRow onRetry={onRetry}>
      Could not load or save{error ? `: ${error}` : '.'}
    </ErrorRow>
  )
}

export function useRelativeTimeTick(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

export function SettingsSection({
  title,
  description,
  children,
  footer,
  headerAction,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  headerAction?: ReactNode
}) {
  return (
    <section>
      <Card className="mt-3">
        <CardHeader>
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            {description && <CardDescription>{description}</CardDescription>}
          </div>
          <CardAction>
            <div className="flex h-5 min-w-5 items-center justify-end">
              {headerAction}
            </div>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col divide-y divide-border p-0 [&>*]:px-6">
          {children}
        </CardContent>
        {footer && (
          <CardFooter className="justify-end gap-2 border-t pt-6">
            {footer}
          </CardFooter>
        )}
      </Card>
    </section>
  )
}

export function SettingsRow({
  label,
  description,
  status,
  control,
  children,
  reset,
  body,
}: {
  label: string
  description?: string
  status?: ReactNode
  children?: ReactNode
  control?: ReactNode
  reset?: ReactNode
  body?: ReactNode
}) {
  return (
    <div className={body ? 'py-0 pt-3' : 'py-3'}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        <div className="flex flex-none flex-wrap items-center justify-end gap-2">
          {control}
          {status}
          {reset}
        </div>
      </div>
      {body ?? children}
    </div>
  )
}

export function SettingResetButton({
  label,
  tooltip = 'Reset to default',
  onClick,
}: {
  label: string
  tooltip?: string
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-5"
            aria-label={`Reset ${label} to default`}
            onClick={onClick}
          />
        }
      >
        <Undo2Icon className="size-3" />
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Settings page column with a header row (title, optional count, right-side
 * actions) and a subtitle. The body is a column with 24px gaps, so the
 * primitives below carry no outer margin. The in-page Back button only shows
 * where the settings nav (and its Back row) is hidden.
 */
export function SettingsPage({
  title,
  subtitle,
  count,
  actions,
  children,
}: {
  title: string
  subtitle: ReactNode
  count?: number
  actions?: ReactNode
  children: ReactNode
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  const sidebarOpen = useShellStore((state) => state.sidebarOpen)
  useEffect(() => headingRef.current?.focus(), [title])
  return (
    <section className="mx-auto w-full max-w-3xl px-4 pt-8 pb-16 sm:px-6">
      <Button
        variant="ghost"
        size="sm"
        className={cn('-ml-2 mb-3', sidebarOpen && 'md:hidden')}
        onClick={() => window.history.back()}
        aria-label="Back to workspace"
      >
        <ArrowLeft className="size-4" />
        Back
      </Button>
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="truncate text-base font-semibold outline-none"
            style={{ outline: 'none', boxShadow: 'none' }}
          >
            {title}
          </h1>
          {count !== undefined && (
            <span className="text-[13px] text-muted-foreground/70 tabular-nums">
              {count}
            </span>
          )}
        </div>
        {actions && (
          <div className="ml-auto flex items-center gap-1">{actions}</div>
        )}
      </div>
      <p className="mt-1 max-w-[512px] text-[13px] leading-5 text-muted-foreground">
        {subtitle}
      </p>
      <div className="mt-6 flex flex-col gap-6">{children}</div>
    </section>
  )
}

/** Bordered card that holds SettingsCardRow items. */
export function SettingsCard({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('overflow-hidden rounded-xl border bg-card', className)}
      {...props}
    />
  )
}

/** One card row; `dimmed` fades rows that cannot be used (missing CLI). */
export function SettingsCardRow({
  dimmed = false,
  className,
  ...props
}: ComponentProps<'div'> & { dimmed?: boolean }) {
  return (
    <div
      className={cn(
        'flex items-center gap-3.5 border-t px-5 py-3.5 first:border-t-0 motion-safe:transition-colors motion-safe:duration-150 pointer-fine:hover:bg-muted/30',
        dimmed && 'opacity-55',
        className,
      )}
      {...props}
    />
  )
}

/** 36px identity tile around a 16px mark or icon. */
export function SettingsIconTile({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'grid size-9 shrink-0 place-items-center rounded-[10px] border bg-muted/40 text-muted-foreground',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** Quiet meta line under a row title; skips empty children, joins with "·". */
export function SettingsMeta({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  const pieces = Children.toArray(children)
  if (pieces.length === 0) return null
  return (
    <div
      className={cn(
        'mt-px flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-muted-foreground/80',
        className,
      )}
    >
      {pieces.map((piece, index) => (
        <Fragment key={index}>
          {index > 0 && (
            <span aria-hidden className="text-muted-foreground/40">
              ·
            </span>
          )}
          {piece}
        </Fragment>
      ))}
    </div>
  )
}

/** Error or warning strip with optional Retry and dismiss actions. */
export function SettingsStrip({
  tone,
  children,
  onRetry,
  onDismiss,
  className,
}: {
  tone: 'error' | 'warning'
  children: ReactNode
  onRetry?: () => void
  onDismiss?: () => void
  className?: string
}) {
  const error = tone === 'error'
  return (
    <div
      role={error ? 'alert' : undefined}
      className={cn(
        'flex items-start gap-2 rounded-xl border px-4',
        error
          ? 'border-destructive/20 bg-destructive/6 py-3 text-[12.5px] text-destructive'
          : 'border-warning/20 bg-warning/6 py-2.5 text-xs text-warning',
        className,
      )}
    >
      <AlertTriangle
        aria-hidden
        className={cn('shrink-0', error ? 'mt-0.5 size-4' : 'mt-px size-3.5')}
      />
      <div className="min-w-0 flex-1 break-words">{children}</div>
      {onRetry && (
        <Button
          variant="link"
          size="xs"
          className="h-auto shrink-0 p-0 text-[length:inherit] text-current"
          onClick={onRetry}
        >
          Retry
        </Button>
      )}
      {onDismiss && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="-my-0.5 shrink-0 text-current"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          <XIcon className="text-current" />
        </Button>
      )}
    </div>
  )
}

/** Loading placeholder shaped like a settings card with `rows` bars. */
export function SettingsSkeletonCard({
  rows = 4,
  className,
}: {
  rows?: number
  className?: string
}) {
  return (
    <SettingsCard
      aria-busy="true"
      className={cn('flex flex-col gap-2 p-4', className)}
    >
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-7 rounded-md" />
      ))}
    </SettingsCard>
  )
}

const METER_FILL = {
  normal: 'bg-primary/80',
  warning: 'bg-warning',
  critical: 'bg-destructive',
} as const

/** One usage window: label, bar, "NN% used", and when it resets. */
export function UsageMeter({
  label,
  percent,
  resetsAt,
  nowMs = Date.now(),
}: {
  label: string
  percent: number
  resetsAt?: string | null
  nowMs?: number
}) {
  const used = Math.round(clampPercent(percent))
  const reset = resetsAt ? formatResetText(resetsAt, nowMs) : null
  return (
    <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground/80">
      <span className="w-12 shrink-0 truncate" title={label}>
        {label}
      </span>
      <div
        role="meter"
        aria-label={`${label} usage`}
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${used}% used${reset ? `, ${reset}` : ''}`}
        className="h-[5px] max-w-[230px] min-w-14 flex-1 overflow-hidden rounded-full bg-muted"
      >
        {used > 0 && (
          <div
            className={cn(
              'h-full rounded-full motion-safe:transition-[width] motion-safe:duration-150',
              METER_FILL[usageMeterTone(used)],
            )}
            style={{ width: `${Math.max(used, 1.5)}%` }}
          />
        )}
      </div>
      <span className="w-16 shrink-0 text-right tabular-nums">
        {used}% used
      </span>
      {reset && (
        <span className="truncate text-muted-foreground/60">{reset}</span>
      )}
    </div>
  )
}
