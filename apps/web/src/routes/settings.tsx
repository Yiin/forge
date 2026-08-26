import { Outlet } from '@tanstack/react-router'
export function SettingsLayout() {
  return (
    <div className="settings-layout">
      <div className="settings-content">
        <Outlet />
      </div>
    </div>
  )
}
