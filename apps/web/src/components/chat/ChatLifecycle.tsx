import {
  CircleAlert,
  CircleCheck,
  LoaderCircle,
  RefreshCw,
  WifiOff,
} from 'lucide-react'
import type { ConnectionState } from '../../lib/socket'
import { Button } from '../ui/button'

export function ChatLifecycle({
  loading,
  error,
  onRetry,
  connection,
  running,
  empty: _empty,
}: {
  loading: boolean
  error?: string
  onRetry: () => void
  connection: ConnectionState
  running: boolean
  empty?: boolean
}) {
  if (loading)
    return (
      <div
        className="chat-lifecycle mx-auto my-6 flex w-fit items-center gap-2 text-sm text-muted-foreground"
        role="status"
      >
        <LoaderCircle className="size-[18px] animate-spin" aria-hidden="true" />
        Loading session…
      </div>
    )
  if (error)
    return (
      <div
        className="chat-lifecycle mx-auto my-6 flex w-[min(680px,calc(100%-32px))] items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        role="alert"
      >
        <span className="flex items-center gap-2">
          <CircleAlert className="size-[18px]" aria-hidden="true" /> {error}
        </span>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="size-4" aria-hidden="true" /> Retry
        </Button>
      </div>
    )
  return (
    <div
      className="chat-lifecycle-status mx-auto flex min-h-7 w-full max-w-[900px] items-center gap-1.5 px-4 py-1 text-xs text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      {connectionLabel(connection, running)}
    </div>
  )
}

function connectionLabel(state: ConnectionState, running: boolean) {
  if (state === 'connected')
    return (
      <>
        <CircleCheck className="size-[15px]" aria-hidden="true" />
        {running ? 'Working' : 'Ready'}
      </>
    )
  if (state === 'reconnecting')
    return (
      <>
        <RefreshCw className="size-[15px] animate-spin" aria-hidden="true" />
        Reconnecting. Your messages are preserved.
      </>
    )
  if (state === 'error')
    return (
      <>
        <CircleAlert className="size-[15px]" aria-hidden="true" />
        Connection error. Retrying…
      </>
    )
  if (state === 'disconnected')
    return (
      <>
        <WifiOff className="size-[15px]" aria-hidden="true" />
        Disconnected
      </>
    )
  return (
    <>
      <LoaderCircle className="size-[15px] animate-spin" aria-hidden="true" />
      Connecting…
    </>
  )
}
