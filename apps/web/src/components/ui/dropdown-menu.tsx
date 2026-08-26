import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

const MenuContext = createContext<{
  open: boolean
  setOpen: (open: boolean) => void
}>({
  open: false,
  setOpen: () => undefined,
})

export function DropdownMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <MenuContext.Provider value={{ open, setOpen }}>
      {children}
    </MenuContext.Provider>
  )
}

export function MenuTrigger({ children }: { children: ReactNode }) {
  const { open, setOpen } = useContext(MenuContext)
  return (
    <button
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => setOpen(!open)}
    >
      {children}
    </button>
  )
}

export function MenuContent({
  children,
  label = 'Menu',
}: {
  children: ReactNode
  label?: string
}) {
  const { open, setOpen } = useContext(MenuContext)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open)
      ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [open])
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open, setOpen])
  if (!open) return null
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    )
    const index = items.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
    }
    if (event.key === 'Home') {
      event.preventDefault()
      items[0]?.focus()
    }
    if (event.key === 'End') {
      event.preventDefault()
      items.at(-1)?.focus()
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      items[(index + 1) % items.length]?.focus()
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      items[(index - 1 + items.length) % items.length]?.focus()
    }
  }
  return (
    <div
      ref={ref}
      className="ui-menu"
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  )
}

export function MenuItem({
  children,
  onSelect,
  disabled = false,
}: {
  children: ReactNode
  onSelect?: () => void
  disabled?: boolean
}) {
  const { setOpen } = useContext(MenuContext)
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={0}
      disabled={disabled}
      onClick={() => {
        onSelect?.()
        setOpen(false)
      }}
    >
      {children}
    </button>
  )
}
