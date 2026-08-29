import { describe, expect, it } from 'vitest'
import { formatContextWindowTokens } from './context-window'

describe('formatContextWindowTokens', () => {
  it.each([
    [999, '999'],
    [1500, '1.5k'],
    [9000, '9k'],
    [157_000, '157k'],
    [1_000_000, '1m'],
  ])('%s formats as %s', (value, expected) => {
    expect(formatContextWindowTokens(value)).toBe(expected)
  })
})
