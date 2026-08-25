import { describe, expect, it } from 'vitest'
import {
  getStartPath,
  readSidebarWidth,
  readTheme,
  writeLastSession,
  writeSidebarWidth,
  writeTheme,
} from '../src/lib/shell-storage'
const storage = () => {
  let values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } as unknown as Storage
}
describe('shell storage', () => {
  it('clamps sidebar width', () => {
    const s = storage()
    writeSidebarWidth(500, s)
    expect(readSidebarWidth(s)).toBe(420)
    writeSidebarWidth(100, s)
    expect(readSidebarWidth(s)).toBe(220)
  })
  it('persists theme', () => {
    const s = storage()
    expect(readTheme(s)).toBe('dark')
    writeTheme('light', s)
    expect(readTheme(s)).toBe('light')
  })
  it('chooses the last session path', () => {
    const s = storage()
    expect(getStartPath(s)).toBe('/')
    writeLastSession('abc/123', s)
    expect(getStartPath(s)).toBe('/s/abc%2F123')
  })
})
