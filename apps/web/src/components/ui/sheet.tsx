import { Dialog } from './dialog'
import type { ReactNode } from 'react'

export function Sheet({
  open,
  onOpenChange,
  children,
  side = 'right',
  title = 'Sheet',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
  side?: 'left' | 'right' | 'top' | 'bottom'
  title?: string
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      className={`sheet-dialog sheet-dialog-${side}`}
    >
      <div className={`ui-sheet ui-sheet-${side}`}>{children}</div>
    </Dialog>
  )
}
