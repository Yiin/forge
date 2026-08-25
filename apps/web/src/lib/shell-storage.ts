const WIDTH_KEY = 'forge.shell.sidebar-width'
const THEME_KEY = 'forge.shell.theme'
const SESSION_KEY = 'forge.shell.last-session'

export type Theme = 'dark' | 'light'
export const readSidebarWidth = (storage: Storage = localStorage) =>
  Number(storage.getItem(WIDTH_KEY) ?? 280)
export const writeSidebarWidth = (
  width: number,
  storage: Storage = localStorage,
) => storage.setItem(WIDTH_KEY, String(Math.min(420, Math.max(220, width))))
export const readTheme = (storage: Storage = localStorage): Theme =>
  storage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'
export const writeTheme = (theme: Theme, storage: Storage = localStorage) =>
  storage.setItem(THEME_KEY, theme)
export const readLastSession = (storage: Storage = localStorage) =>
  storage.getItem(SESSION_KEY)
export const writeLastSession = (id: string, storage: Storage = localStorage) =>
  storage.setItem(SESSION_KEY, id)
export const getStartPath = (storage: Storage = localStorage) => {
  const id = readLastSession(storage)
  return id ? `/s/${encodeURIComponent(id)}` : '/'
}
