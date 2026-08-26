import { Outlet } from '@tanstack/react-router'
import { SettingsNav } from '../components/settings/SettingsNav'
export function SettingsLayout() {
  return (
    <div className="settings-layout">
      <SettingsNav />
      <div className="settings-content">
        <Outlet />
      </div>
    </div>
  )
}
