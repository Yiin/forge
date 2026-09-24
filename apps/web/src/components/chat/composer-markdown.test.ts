import { describe, expect, it } from 'vitest'
import {
  continueList,
  indentList,
  mentionBefore,
  parseDraft,
  type Mentions,
} from './composer-markdown'

/** The draft as `[text, marks]` pairs, for readable assertions. */
const spans = (text: string, mentions: Mentions = {}) =>
  parseDraft(text, mentions).flatMap((line) =>
    line.segments.map((segment) => [
      text.slice(segment.start, segment.end),
      segment.marks.join(' '),
    ]),
  )

describe('parseDraft', () => {
  it('styles emphasis, strike and inline code with their delimiters', () => {
    expect(spans('a **b** *c* ~~d~~ `e`')).toEqual([
      ['a ', ''],
      ['**', 'delim'],
      ['b', 'strong'],
      ['**', 'delim'],
      [' ', ''],
      ['*', 'delim'],
      ['c', 'em'],
      ['*', 'delim'],
      [' ', ''],
      ['~~', 'delim'],
      ['d', 'strike'],
      ['~~', 'delim'],
      [' ', ''],
      ['`', 'code delim'],
      ['e', 'code'],
      ['`', 'code delim'],
    ])
  })

  it('nests emphasis and keeps code spans literal', () => {
    expect(spans('*a **b** c*')).toEqual([
      ['*', 'delim'],
      ['a ', 'em'],
      ['**', 'em delim'],
      ['b', 'em strong'],
      ['**', 'em delim'],
      [' c', 'em'],
      ['*', 'delim'],
    ])
    expect(spans('`**not bold**`')).toEqual([
      ['`', 'code delim'],
      ['**not bold**', 'code'],
      ['`', 'code delim'],
    ])
  })

  it('leaves unmatched, spaced and intraword underscores as text', () => {
    expect(spans('2 * 3 * 4')).toEqual([['2 * 3 * 4', '']])
    expect(spans('snake_case_name')).toEqual([['snake_case_name', '']])
    expect(spans('**open')).toEqual([['**open', '']])
    expect(spans('\\*not em\\*')).toEqual([['\\*not em\\*', '']])
  })

  it('marks headings and list bullets', () => {
    expect(spans('## Title **x**')).toEqual([
      ['## ', 'heading delim'],
      ['Title ', 'heading'],
      ['**', 'heading delim'],
      ['x', 'heading strong'],
      ['**', 'heading delim'],
    ])
    expect(spans('  - item\n2. next')).toEqual([
      ['  ', ''],
      ['- ', 'list'],
      ['item', ''],
      ['2. ', 'list'],
      ['next', ''],
    ])
  })

  it('treats fenced blocks as code without inline styling', () => {
    const lines = parseDraft('```ts\nconst a = **b**\n```\nafter')
    expect(lines.map((line) => line.fence)).toEqual([true, true, true, false])
    expect(lines[1]!.segments).toEqual([
      { start: 6, end: 21, marks: ['fence'] },
    ])
    expect(lines[2]!.segments[0]!.marks).toEqual(['fence', 'delim'])
  })

  it('chips only picked files and skills', () => {
    const mentions = {
      files: new Set(['src/app.ts']),
      skills: new Set(['review']),
    }
    expect(spans('see @src/app.ts, $review and @other $5', mentions)).toEqual([
      ['see ', ''],
      ['@src/app.ts', 'mention'],
      [', ', ''],
      ['$review', 'mention'],
      [' and @other $5', ''],
    ])
    // Not after a word character: an email address stays text.
    expect(spans('me@src/app.ts', mentions)).toEqual([['me@src/app.ts', '']])
  })

  it('keeps offsets across lines', () => {
    const lines = parseDraft('one\n\n**two**')
    expect(lines.map(({ start, end }) => [start, end])).toEqual([
      [0, 3],
      [4, 4],
      [5, 12],
    ])
  })
})

describe('mentionBefore', () => {
  it('finds a chip that ends at the caret', () => {
    const files = { files: new Set(['a.ts']) }
    expect(mentionBefore('x @a.ts', 7, files)).toEqual({ start: 2, end: 7 })
    expect(mentionBefore('x @a.ts ', 8, files)).toBeUndefined()
    expect(mentionBefore('l1\n@a.ts', 8, files)).toEqual({ start: 3, end: 8 })
  })
})

describe('continueList', () => {
  it('continues bullets, numbers and task boxes', () => {
    expect(continueList('- a', 3, 3)).toEqual({
      start: 3,
      end: 3,
      text: '\n- ',
      caret: 6,
    })
    expect(continueList('  9) a', 6, 6)?.text).toBe('\n  10) ')
    expect(continueList('- [x] done', 10, 10)?.text).toBe('\n- [ ] ')
  })

  it('ends the list on an empty item and ignores plain lines', () => {
    expect(continueList('- a\n- ', 6, 6)).toEqual({
      start: 4,
      end: 6,
      text: '',
      caret: 4,
    })
    expect(continueList('plain', 5, 5)).toBeNull()
  })
})

describe('indentList', () => {
  it('indents and outdents the selected list lines', () => {
    expect(indentList('- a\n- b', 5, 5, false)).toEqual({
      start: 4,
      end: 7,
      text: '  - b',
      caret: 7,
      selection: [7, 7],
    })
    expect(indentList('- a\n  - b', 0, 9, true)).toMatchObject({
      start: 0,
      end: 9,
      text: '- a\n- b',
      selection: [0, 7],
    })
  })

  it('leaves Tab alone outside lists and at the left edge', () => {
    expect(indentList('text', 2, 2, false)).toBeNull()
    expect(indentList('- a', 1, 1, true)).toBeNull()
  })
})
