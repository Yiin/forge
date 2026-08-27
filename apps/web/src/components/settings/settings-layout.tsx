import { AlertCircle, ArrowLeft, Undo2Icon } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

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
  description?: string
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
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-5"
          aria-label={`Reset ${label} to default`}
          onClick={onClick}
        >
          <Undo2Icon className="size-3" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}

export function SettingsPage({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: ReactNode
}) {
  return (
    <section className="mx-auto max-w-3xl px-4 py-6 sm:px-6 md:py-10">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 mb-2"
        onClick={() => window.history.back()}
        aria-label="Back to workspace"
      >
        <ArrowLeft className="size-4" />
        Back
      </Button>
      <h1
        tabIndex={-1}
        className="text-xl font-semibold tracking-tight outline-none"
        style={{ outline: 'none', boxShadow: 'none' }}
      >
        {title}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
      <div className="mt-6 flex flex-col gap-6">{children}</div>
    </section>
  )
}
