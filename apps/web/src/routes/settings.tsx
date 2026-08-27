import { Outlet } from '@tanstack/react-router'
import { useEffect } from 'react'

function ownsEscape(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(
    target.closest(
      'dialog[open], [role="dialog"], [role="menu"], [role="listbox"], [contenteditable="true"], input, textarea, select, [data-settings-editor]',
    ),
  )
}
export function SettingsLayout() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.isComposing ||
        ownsEscape(event.target)
      )
        return
      window.history.back()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
  return (
    <div className="h-full min-h-0 overflow-auto">
      <Outlet />
    </div>
  )
}
