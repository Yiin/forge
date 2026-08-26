import type { ComposerTriggerKind } from './composer-triggers'
import type { ComposerCommand } from './CommandMenu'

export function groupComposerCommands(commands: ComposerCommand[], kind: ComposerTriggerKind | null) {
  const groups = kind === 'slash-command' ? ['Built-in', 'Harness'] : kind === 'skill' ? ['Skills'] : kind === 'path' ? ['Files'] : ['Built-in', 'Harness', 'Skills', 'Files']
  return groups.map((group) => ({ group, commands: commands.filter((command) => command.group === group) })).filter((entry) => entry.commands.length)
}
