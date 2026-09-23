import { CircleAlert, LoaderCircle, RefreshCw, WifiOff } from 'lucide-react'
import type { ConnectionState } from '../../lib/socket'
import { Button } from '../ui/button'
import { GradientSpinner } from './WorkingLine'

export function ChatLifecycle({
  loading,
  error,
  onRetry,
  connection,
  empty: _empty,
}: {
  loading: boolean
  error?: string
  onRetry: () => void
  connection: ConnectionState
  empty?: boolean
}) {
  if (loading)
    return (
      <div
        className="chat-lifecycle mx-auto my-6 flex w-fit items-center gap-2 text-xs text-muted-foreground"
        role="status"
      >
        <GradientSpinner />
        Loading session…
      </div>
    )
  if (error)
    return (
      <div className="flex w-full justify-center px-5 py-6 sm:px-12">
        <div
          className="chat-lifecycle flex w-full max-w-(--transcript-width) items-center gap-2 rounded-[10px] border border-destructive/16 bg-destructive/5 px-2.5 py-2 text-xs leading-4"
          role="alert"
        >
          <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-destructive/12">
            <CircleAlert
              className="size-3 text-destructive-foreground/80"
              aria-hidden="true"
            />
          </span>
          <span className="min-w-0 flex-1 text-foreground/80">{error}</span>
          <Button variant="ghost" size="xs" onClick={onRetry}>
            <RefreshCw aria-hidden="true" /> Retry
          </Button>
        </div>
      </div>
    )
  if (connection === 'connected') return null
  return (
    <div className="flex w-full justify-center px-5 sm:px-12">
      <div
        className="chat-lifecycle-status flex min-h-7 w-full max-w-(--transcript-width) items-center gap-1.5 py-1 text-xs text-muted-foreground [&_svg]:size-[13px]"
        role="status"
        aria-live="polite"
      >
        {connectionLabel(connection)}
      </div>
    </div>
  )
}

function connectionLabel(state: ConnectionState) {
  if (state === 'reconnecting')
    return (
      <>
        <RefreshCw className="animate-spin" aria-hidden="true" />
        Reconnecting. Your messages are preserved.
      </>
    )
  if (state === 'error')
    return (
      <>
        <CircleAlert aria-hidden="true" />
        Connection error. Retrying…
      </>
    )
  if (state === 'disconnected')
    return (
      <>
        <WifiOff aria-hidden="true" />
        Disconnected
      </>
    )
  return (
    <>
      <LoaderCircle className="animate-spin" aria-hidden="true" />
      Connecting…
    </>
  )
}
