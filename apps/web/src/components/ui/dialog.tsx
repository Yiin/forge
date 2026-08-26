import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'

function focusable(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  )
}

export function Dialog({
  open,
  onOpenChange,
  children,
  title = 'Dialog',
  description,
  className,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
  title?: string
  description?: string
  className?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const descriptionId = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-description`
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open) {
      trigger.current = document.activeElement as HTMLElement
      if (!dialog.open) {
        try {
          dialog.showModal()
        } catch {
          dialog.setAttribute('open', '')
        }
      }
      requestAnimationFrame(() => focusable(dialog)[0]?.focus())
    } else if (dialog.open || dialog.hasAttribute('open')) {
      if (typeof dialog.close === 'function') dialog.close()
      else dialog.removeAttribute('open')
      trigger.current?.focus()
      trigger.current = null
    }
  }, [open])
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onOpenChange(false)
      return
    }
    if (event.key !== 'Tab') return
    const items = focusable(event.currentTarget)
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
  return (
    <dialog
      ref={ref}
      className={`palette-dialog ui-dialog ${className ?? ''}`}
      aria-label={title}
      aria-describedby={description ? descriptionId : undefined}
      aria-modal="true"
      onKeyDown={onKeyDown}
      onCancel={() => onOpenChange(false)}
    >
      {children}
    </dialog>
  )
}

export function DialogTitle({
  children,
  id,
}: {
  children: ReactNode
  id?: string
}) {
  return (
    <h2 id={id} className="ui-dialog-title">
      {children}
    </h2>
  )
}

export function DialogDescription({
  children,
  id,
}: {
  children: ReactNode
  id?: string
}) {
  return (
    <p id={id} className="ui-dialog-description">
      {children}
    </p>
  )
}
