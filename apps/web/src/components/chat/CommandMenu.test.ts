import { describe, expect, it } from 'vitest'
import {
  emptyCommandText,
  filterComposerCommands,
  groupComposerCommands,
} from './command-menu-logic'
import type { ComposerCommand } from './CommandMenu'

const commands: ComposerCommand[] = [
  { id: 'a', label: '/help', group: 'Built-in' },
  { id: 'b', label: 'compact', group: 'Harness' },
  { id: 'c', label: '$review', group: 'Skills' },
  { id: 'd', label: '@README.md', group: 'Files' },
]
describe('command menu groups', () => {
  it('shows only relevant groups for each trigger', () => {
    expect(
      groupComposerCommands(commands, 'slash-command').map(
        (item) => item.group,
      ),
    ).toEqual(['Built-in', 'Harness'])
    expect(
      groupComposerCommands(commands, 'skill').map((item) => item.group),
    ).toEqual(['Skills'])
    expect(
      groupComposerCommands(commands, 'path').map((item) => item.group),
    ).toEqual(['Files'])
  })
})

describe('command menu filter', () => {
  const rows: ComposerCommand[] = [
    { id: 'a', label: '/review', group: 'Harness' },
    { id: 'b', label: '/preview', group: 'Harness' },
    { id: 'c', label: '/help', group: 'Built-in' },
  ]
  it('ranks prefix matches before substring matches, ignoring the sigil', () => {
    expect(
      filterComposerCommands(rows, 'slash-command', 'rev').map(
        (row) => row.label,
      ),
    ).toEqual(['/review', '/preview'])
    expect(
      filterComposerCommands(rows, 'slash-command', '').map((row) => row.id),
    ).toEqual(['c', 'a', 'b'])
  })
  it('names the empty state per trigger', () => {
    expect(emptyCommandText(rows, 'skill')).toBe(
      'No skills available for this project',
    )
    expect(emptyCommandText(rows, 'slash-command')).toBe('No matching commands')
  })
})
