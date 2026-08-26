import {
  CircleAlert,
  CircleCheck,
  LoaderCircle,
  RefreshCw,
  WifiOff,
} from 'lucide-react'
import type { ConnectionState } from '../../lib/socket'

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
      <div className="chat-lifecycle status-panel" role="status">
        <LoaderCircle size={18} aria-hidden="true" /> Loading session…
      </div>
    )
  if (error)
    return (
      <div className="chat-lifecycle status-panel status-error" role="alert">
        <span>
          <CircleAlert size={18} aria-hidden="true" /> {error}
        </span>
        <button type="button" onClick={onRetry}>
          <RefreshCw size={16} aria-hidden="true" /> Retry
        </button>
      </div>
    )
  return (
    <>
      <div className="chat-lifecycle-status" role="status" aria-live="polite">
        {connectionLabel(connection, running)}
      </div>
    </>
  )
}

function connectionLabel(state: ConnectionState, running: boolean) {
  if (state === 'connected')
    return (
      <>
        <CircleCheck size={15} aria-hidden="true" />{' '}
        {running ? 'Working' : 'Ready'}
      </>
    )
  if (state === 'reconnecting')
    return (
      <>
        <RefreshCw size={15} aria-hidden="true" /> Reconnecting. Your messages
        are preserved.
      </>
    )
  if (state === 'error')
    return (
      <>
        <CircleAlert size={15} aria-hidden="true" /> Connection error. Retrying…
      </>
    )
  if (state === 'disconnected')
    return (
      <>
        <WifiOff size={15} aria-hidden="true" /> Disconnected
      </>
    )
  return (
    <>
      <LoaderCircle size={15} aria-hidden="true" /> Connecting…
    </>
  )
}
