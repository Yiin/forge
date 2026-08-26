import { describe, expect, it } from 'vitest'
import { groupComposerCommands } from './command-menu-logic'
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
