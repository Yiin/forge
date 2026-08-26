import { Button } from './button'

export function StatusPanel({
  status,
  message,
  onRetry,
  action,
}: {
  status: 'loading' | 'error' | 'empty' | 'success'
  message: string
  onRetry?: () => void
  action?: { label: string; onClick: () => void }
}) {
  if (status === 'loading')
    return (
      <div className="status-panel" role="status" aria-busy="true">
        {message}
      </div>
    )
  if (status === 'error')
    return (
      <div className="status-panel status-error" role="alert">
        <span>{message}</span>
        {onRetry && <Button onClick={onRetry}>Retry</Button>}
      </div>
    )
  if (status === 'empty')
    return (
      <div className="status-panel">
        <span>{message}</span>
        {action && <Button onClick={action.onClick}>{action.label}</Button>}
      </div>
    )
  return (
    <div className="status-panel status-success" role="status">
      {message}
    </div>
  )
}
