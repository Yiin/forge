import { useState, type ReactNode } from 'react'
import { Button } from './button'
import { Dialog, DialogTitle } from './dialog'

export function ConfirmationDialog({
  open,
  onOpenChange,
  onConfirm,
  title = 'Confirm action',
  children,
  confirmLabel = 'Confirm',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void | Promise<void>
  title?: string
  children: ReactNode
  confirmLabel?: string
}) {
  const [pending, setPending] = useState(false)
  const confirm = async () => {
    if (pending) return
    setPending(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title}>
      <div className="confirmation-dialog">
        <DialogTitle>{title}</DialogTitle>
        <div>{children}</div>
        <div className="confirmation-actions">
          <Button onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void confirm()}
            loading={pending}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
