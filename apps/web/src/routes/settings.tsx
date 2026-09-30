import { Outlet, useRouter } from '@tanstack/react-router'
import { leaveSettings } from '../lib/settings-exit'
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
  const router = useRouter()
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.isComposing ||
        ownsEscape(event.target)
      )
        return
      leaveSettings(router.history)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [router.history])
  return (
    <div className="h-full min-h-0 overflow-auto">
      <Outlet />
    </div>
  )
}
