import { describe, expect, it } from 'vitest'
import { capThoughtLines, thoughtLines } from './thought-lines'

const plain = (markdown: string) =>
  thoughtLines(markdown).map((line) => line.map((span) => span.text).join(''))

describe('thought lines', () => {
  it('flattens markdown blocks to single lines', () => {
    expect(
      plain(
        '## Plan\n\nFirst **check** the `tests`.\n\n- one\n- two\n\n> quoted\n\n---',
      ),
    ).toEqual([
      'Plan',
      '',
      'First check the tests.',
      '',
      '• one',
      '• two',
      '',
      '│ quoted',
      '',
      '———',
    ])
  })

  it('keeps inline styles as spans', () => {
    const [line] = thoughtLines('a **b** *c* `d` [e](https://x.test)')
    expect(line.filter((span) => span.text.trim())).toEqual([
      { text: 'a ' },
      { text: 'b', bold: true },
      { text: 'c', italic: true },
      { text: 'd', code: true },
      { text: 'e', link: true },
    ])
  })

  it('wraps at 96 columns', () => {
    const lines = plain(Array.from({ length: 40 }, () => 'word').join(' '))
    expect(lines.length).toBe(3)
    expect(lines.every((line) => line.length <= 96)).toBe(true)
  })

  it('keeps the newest lines while live and the first once settled', () => {
    const lines = thoughtLines(
      Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n\n'),
    ).filter((line) => line.length)
    expect(capThoughtLines(lines, true)).toMatchObject({ hidden: 6 })
    expect(capThoughtLines(lines, true).lines[0][0].text).toBe('line 6')
    expect(capThoughtLines(lines, false).lines[0][0].text).toBe('line 0')
  })
})
