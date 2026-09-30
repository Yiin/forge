import { describe, expect, it } from 'vitest'
import {
  isDefaultTitle,
  sanitizeTitle,
  titleFromPrompt,
  titleFromReply,
  titleRequest,
} from './titles.js'

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

describe('generated titles', () => {
  it('asks for a short topic title from the latest exchange', () => {
    const prompt = titleRequest(
      [
        { role: 'user', text: 'first ask' },
        { role: 'user', text: 'second ask' },
        { role: 'assistant', text: 'the reply' },
      ],
      'Current title',
    )
    expect(prompt).toContain('Opening request:\nfirst ask')
    expect(prompt).toContain('Latest request:\nsecond ask')
    expect(prompt).toContain('Latest reply:\nthe reply')
    expect(prompt).toContain('Current title')
  })

  it('reads the first line of the reply as the title', () => {
    expect(titleFromReply('"Two-line sidebar rows."\n')).toBe(
      'Two-line sidebar rows',
    )
    expect(titleFromReply('\n  **Settings back button**')).toBe(
      'Settings back button',
    )
    expect(titleFromReply('   ')).toBeNull()
  })
})
