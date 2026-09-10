const WIDTH_KEY = 'forge.shell.sidebar-width'
const THEME_KEY = 'forge.shell.theme'
const SESSION_KEY = 'forge.shell.last-session'
export const SIDEBAR_WIDTH_DEFAULT = 256
export const SIDEBAR_WIDTH_MIN = 208
export const SIDEBAR_WIDTH_MAX = 400

export type Theme = 'system' | 'dark' | 'light'
export type ResolvedTheme = Exclude<Theme, 'system'>
export const readSidebarWidth = (storage: Storage = localStorage) => {
  const value = Number(storage.getItem(WIDTH_KEY) ?? SIDEBAR_WIDTH_DEFAULT)
  return Number.isFinite(value)
    ? Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, value))
    : SIDEBAR_WIDTH_DEFAULT
}
export const writeSidebarWidth = (
  width: number,
  storage: Storage = localStorage,
) => storage.setItem(WIDTH_KEY, String(Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, width))))
export const readTheme = (storage: Storage = localStorage): Theme => {
  const value = storage.getItem(THEME_KEY)
  return value === 'light' || value === 'dark' || value === 'system'
    ? value
    : 'system'
}
export const writeTheme = (theme: Theme, storage: Storage = localStorage) =>
  storage.setItem(THEME_KEY, theme)
export const resolveTheme = (
  theme: Theme,
  matchesDark = typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches,
): ResolvedTheme =>
  theme === 'system' ? (matchesDark ? 'dark' : 'light') : theme
export const readLastSession = (storage: Storage = localStorage) =>
  storage.getItem(SESSION_KEY)
export const writeLastSession = (id: string, storage: Storage = localStorage) =>
  storage.setItem(SESSION_KEY, id)
export const clearLastSession = (storage: Storage = localStorage) =>
  storage.removeItem(SESSION_KEY)
export const getStartPath = (storage: Storage = localStorage) => {
  const id = readLastSession(storage)
  return id ? `/s/${encodeURIComponent(id)}` : '/'
}
