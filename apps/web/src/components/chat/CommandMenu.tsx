import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '../ui/command'
import type { ComposerTriggerKind } from './composer-triggers'
import { groupComposerCommands } from './command-menu-logic'

export type ComposerCommand = { id: string; label: string; group: 'Built-in' | 'Harness' | 'Skills' | 'Files'; value?: string }
export function CommandMenu({ commands, kind, query, onSelect }: { commands: ComposerCommand[]; kind: ComposerTriggerKind | null; query: string; onSelect: (command: ComposerCommand) => void }) {
  const groups = groupComposerCommands(commands, kind)
  return <Command className="composer-command-menu" shouldFilter={false}>
    <CommandList>
      <CommandEmpty>No matching commands.</CommandEmpty>
      {groups.map(({ group, commands: items }) => <CommandGroup heading={group} key={group}>
        {items.filter((item) => item.label.toLowerCase().includes(query.toLowerCase())).map((item) => <CommandItem key={item.id} value={item.id} onSelect={() => onSelect(item)}>{item.label}</CommandItem>)}
      </CommandGroup>)}
    </CommandList>
  </Command>
}
