export type UiFont = 'geist' | 'system' | 'mono'

export type AppearancePreferences = {
  font: UiFont
  fontSize: number
}

export type FilePreferences = {
  autosave: boolean
  autosaveDelayMs: number
  editorFontSize: number
}

export type NotificationPreferences = {
  completion: boolean
  requests: boolean
}

const keys = {
  appearance: 'forge.settings.appearance',
  files: 'forge.settings.files',
  notifications: 'forge.settings.notifications',
} as const

const defaults = {
  appearance: { font: 'geist', fontSize: 16 } satisfies AppearancePreferences,
  files: {
    autosave: false,
    autosaveDelayMs: 900,
    editorFontSize: 13,
  } satisfies FilePreferences,
  notifications: {
    completion: true,
    requests: true,
  } satisfies NotificationPreferences,
}

function read<T>(key: string, fallback: T): T {
  if (typeof localStorage === 'undefined') return fallback
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    return value && typeof value === 'object'
      ? { ...fallback, ...(value as object) }
      : fallback
  } catch {
    return fallback
  }
}

function write<T>(key: string, value: T) {
  if (typeof localStorage !== 'undefined')
    localStorage.setItem(key, JSON.stringify(value))
}

export function readAppearancePreferences() {
  return read(keys.appearance, defaults.appearance)
}

export function writeAppearancePreferences(value: AppearancePreferences) {
  write(keys.appearance, value)
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.uiFont = value.font
    document.documentElement.style.setProperty(
      '--forge-ui-font-size',
      `${value.fontSize}px`,
    )
  }
}

export function readFilePreferences() {
  return read(keys.files, defaults.files)
}

export function writeFilePreferences(value: FilePreferences) {
  write(keys.files, value)
  if (typeof document !== 'undefined')
    document.documentElement.style.setProperty(
      '--forge-editor-font-size',
      `${value.editorFontSize}px`,
    )
}

export function readNotificationPreferences() {
  return read(keys.notifications, defaults.notifications)
}

export function writeNotificationPreferences(value: NotificationPreferences) {
  write(keys.notifications, value)
}

export function applyStoredPreferences() {
  writeAppearancePreferences(readAppearancePreferences())
  writeFilePreferences(readFilePreferences())
}

export const defaultSettingsPreferences = defaults
