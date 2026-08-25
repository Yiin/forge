import { describe, expect, it } from 'vitest'
import {
  messageHitUrl,
  SEARCH_DEBOUNCE_MS,
  searchDue,
  searchUrl,
} from '../src/components/palette/palette-logic'
describe('palette query routing', () => {
  it('uses a 150ms debounce boundary', () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(150)
    expect(searchDue('hello', 100, 249)).toBe(false)
    expect(searchDue('hello', 100, 250)).toBe(true)
    expect(searchDue(' ', 100, 1000)).toBe(false)
  })
  it('maps hits to URLs', () => {
    expect(messageHitUrl('ses_1/a', 42)).toBe('/s/ses_1%2Fa?m=42')
    expect(searchUrl('hello world')).toBe('/search?q=hello%20world')
  })
})
