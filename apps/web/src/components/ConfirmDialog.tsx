import { useState, type ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog'
import { Button } from './ui/button'
import { Spinner } from './ui/spinner'

export function ConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  title = 'Confirm action',
  children,
  confirmLabel = 'Confirm',
  destructive = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void | Promise<void>
  title?: string
  children: ReactNode
  confirmLabel?: string
  destructive?: boolean
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
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription render={<div />}>
            {children}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={() => void confirm().catch(() => undefined)}
            disabled={pending}
          >
            {pending && <Spinner />}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
