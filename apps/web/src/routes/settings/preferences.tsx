import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useShellStore } from '../../stores/shell'
import {
  defaultSettingsPreferences,
  readAppearancePreferences,
  readFilePreferences,
  readNotificationPreferences,
  writeAppearancePreferences,
  writeFilePreferences,
  writeNotificationPreferences,
  type AppearancePreferences,
  type FilePreferences,
  type NotificationPreferences,
} from '../../lib/settings-preferences'
import {
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from '../../routes/settings-pages-implementation'

export function AppearanceSettings() {
  const theme = useShellStore((state) => state.theme)
  const setTheme = useShellStore((state) => state.setTheme)
  const [value, setValue] = useState<AppearancePreferences>(
    readAppearancePreferences,
  )
  const update = (patch: Partial<AppearancePreferences>) => {
    const next = { ...value, ...patch }
    setValue(next)
    writeAppearancePreferences(next)
  }
  return (
    <SettingsPage
      title="Appearance"
      subtitle="Choose how Forge looks and reads."
    >
      <SettingsSection
        title="Interface"
        description="These preferences stay in this browser."
      >
        <SettingsRow
          label="Font"
          description="Use the bundled Geist font, your system font, or a mono font."
        >
          <Select
            value={value.font}
            items={{ geist: 'Geist', system: 'System', mono: 'Geist Mono' }}
            onValueChange={(font) => {
              if (font === 'geist' || font === 'system' || font === 'mono')
                update({ font })
            }}
          >
            <SelectTrigger className="w-36" aria-label="Interface font">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="geist">Geist</SelectItem>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="mono">Geist Mono</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          label="Font size"
          description="The interface text size, from 12 to 20 pixels."
        >
          <Input
            className="w-24"
            aria-label="Interface font size"
            type="number"
            min="12"
            max="20"
            value={value.fontSize}
            onChange={(event) =>
              update({
                fontSize: Math.min(
                  20,
                  Math.max(12, Number(event.target.value) || 16),
                ),
              })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Theme"
          description="Choose the color theme for Forge."
        >
          <Select
            value={theme}
            items={{ system: 'System', light: 'Light', dark: 'Dark' }}
            onValueChange={(value) => {
              if (value === 'system' || value === 'light' || value === 'dark')
                setTheme(value)
            }}
          >
            <SelectTrigger className="w-36" aria-label="Theme">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection
        title="Restore"
        description="Reset appearance preferences in this browser."
      >
        <Button
          variant="outline"
          onClick={() => {
            setValue(defaultSettingsPreferences.appearance)
            writeAppearancePreferences(defaultSettingsPreferences.appearance)
          }}
        >
          Restore appearance defaults
        </Button>
      </SettingsSection>
    </SettingsPage>
  )
}

export function FileSettings() {
  const [value, setValue] = useState<FilePreferences>(readFilePreferences)
  const update = (patch: Partial<FilePreferences>) => {
    const next = { ...value, ...patch }
    setValue(next)
    writeFilePreferences(next)
  }
  return (
    <SettingsPage
      title="Files"
      subtitle="Set editor and save behavior for workspace files."
    >
      <SettingsSection
        title="Editor"
        description="These values apply to the workspace file editor."
      >
        <SettingsRow
          label="Autosave"
          description="Save clean edits after the delay below."
        >
          <Switch
            checked={value.autosave}
            aria-label="Enable file autosave"
            onCheckedChange={(autosave) => update({ autosave })}
          />
        </SettingsRow>
        <SettingsRow
          label="Autosave delay"
          description="Delay from 100 to 10000 milliseconds."
        >
          <Input
            className="w-28"
            aria-label="Autosave delay"
            type="number"
            min="100"
            max="10000"
            step="100"
            value={value.autosaveDelayMs}
            onChange={(event) =>
              update({
                autosaveDelayMs: Math.min(
                  10000,
                  Math.max(100, Number(event.target.value) || 900),
                ),
              })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Editor font size"
          description="Code text size, from 9 to 24 pixels."
        >
          <Input
            className="w-24"
            aria-label="Editor font size"
            type="number"
            min="9"
            max="24"
            value={value.editorFontSize}
            onChange={(event) =>
              update({
                editorFontSize: Math.min(
                  24,
                  Math.max(9, Number(event.target.value) || 13),
                ),
              })
            }
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection
        title="Restore"
        description="Reset file preferences in this browser."
      >
        <Button
          variant="outline"
          onClick={() => {
            setValue(defaultSettingsPreferences.files)
            writeFilePreferences(defaultSettingsPreferences.files)
          }}
        >
          Restore file defaults
        </Button>
      </SettingsSection>
    </SettingsPage>
  )
}

export function NotificationSettings() {
  const [value, setValue] = useState<NotificationPreferences>(
    readNotificationPreferences,
  )
  const [permission, setPermission] = useState<
    NotificationPermission | 'unsupported'
  >(() =>
    typeof Notification === 'undefined'
      ? 'unsupported'
      : Notification.permission,
  )
  useEffect(() => {
    if (typeof Notification !== 'undefined')
      setPermission(Notification.permission)
  }, [])
  const update = (patch: Partial<NotificationPreferences>) => {
    const next = { ...value, ...patch }
    setValue(next)
    writeNotificationPreferences(next)
  }
  const requestPermission = async () => {
    if (typeof Notification === 'undefined') return
    setPermission(await Notification.requestPermission())
  }
  const blocked = permission === 'denied' || permission === 'unsupported'
  return (
    <SettingsPage
      title="Notifications"
      subtitle="Choose which Forge events can notify you."
    >
      <SettingsSection
        title="Browser permission"
        description="Forge asks only after you press the button."
      >
        <SettingsRow
          label="Permission"
          description={
            permission === 'granted'
              ? 'Browser notifications are allowed.'
              : permission === 'denied'
                ? 'Browser notifications are blocked. Change this in browser settings.'
                : permission === 'unsupported'
                  ? 'This browser does not support notifications.'
                  : 'Permission has not been requested.'
          }
        >
          <Button
            variant="outline"
            disabled={blocked || permission === 'granted'}
            onClick={() => void requestPermission()}
          >
            {permission === 'granted'
              ? 'Allowed'
              : blocked
                ? 'Unavailable'
                : 'Allow notifications'}
          </Button>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection
        title="Events"
        description="Requests stay visible in Forge even when notifications are unavailable."
      >
        <SettingsRow
          label="Run completion"
          description="Notify when a run completes or fails."
        >
          <Switch
            checked={value.completion}
            aria-label="Notify on run completion"
            onCheckedChange={(completion) => update({ completion })}
          />
        </SettingsRow>
        <SettingsRow
          label="Questions and permissions"
          description="Notify when a run needs your response."
        >
          <Switch
            checked={value.requests}
            aria-label="Notify on requests"
            onCheckedChange={(requests) => update({ requests })}
          />
        </SettingsRow>
      </SettingsSection>
    </SettingsPage>
  )
}
