import { describe, expect, it } from 'vitest'
import { isDefaultTitle, sanitizeTitle, titleFromPrompt } from './titles.js'

describe('session titles', () => {
  it('removes bead-shaped ids and limits titles to eight words', () => {
    const title = sanitizeTitle(
      'Fix forge-3b7.44 then improve the login flow for the team today',
    )
    expect(title).not.toMatch(/forge-3b7/i)
    expect(title.split(' ')).toHaveLength(8)
  })
  it('falls back when output is empty', () => {
    expect(sanitizeTitle('forge-3b7')).toBe('New session')
    expect(titleFromPrompt('')).toBe('New session')
  })
  it('recognizes only the automatic default', () => {
    expect(isDefaultTitle('New session')).toBe(true)
    expect(isDefaultTitle('A New Session')).toBe(false)
  })
})
