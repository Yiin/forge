import { describe, expect, it } from 'vitest'
import {
  readSidebarWidth,
  writeSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from './shell-storage'

function storage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    },
  } as Storage
}

describe('shell sidebar storage', () => {
  it('uses Comet dimensions and clamps saved widths', () => {
    const saved = storage()
    expect(readSidebarWidth(saved)).toBe(SIDEBAR_WIDTH_DEFAULT)
    writeSidebarWidth(100, saved)
    expect(readSidebarWidth(saved)).toBe(SIDEBAR_WIDTH_MIN)
    writeSidebarWidth(999, saved)
    expect(readSidebarWidth(saved)).toBe(SIDEBAR_WIDTH_MAX)
  })
})
