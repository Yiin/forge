import { File, SlashSquare, Sparkles, Wrench } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '../ui/command'
import type { ComposerTriggerKind } from './composer-triggers'
import { groupComposerCommands } from './command-menu-logic'

export type ComposerCommand = {
  id: string
  label: string
  group: 'Built-in' | 'Harness' | 'Skills' | 'Files'
  value?: string
}

const groupIcons: Record<ComposerCommand['group'], typeof File> = {
  'Built-in': SlashSquare,
  Harness: Wrench,
  Skills: Sparkles,
  Files: File,
}

export function CommandMenu({
  commands,
  kind,
  query,
  onSelect,
  onDismiss,
}: {
  commands: ComposerCommand[]
  kind: ComposerTriggerKind | null
  query: string
  onSelect: (command: ComposerCommand) => void
  onDismiss: () => void
}) {
  const groups = groupComposerCommands(commands, kind)
  return (
    <Command
      data-composer-menu=""
      className="absolute inset-x-0 bottom-[calc(100%+0.5rem)] z-10 h-auto rounded-lg border shadow-md duration-150 animate-in fade-in-0 zoom-in-95"
      shouldFilter={false}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onDismiss()
        }
      }}
    >
      <CommandList>
        <CommandEmpty>No matching commands.</CommandEmpty>
        {groups.map(({ group, commands: items }) => (
          <CommandGroup heading={group} key={group}>
            {items
              .filter((item) =>
                item.label.toLowerCase().includes(query.toLowerCase()),
              )
              .map((item) => {
                const Icon = groupIcons[item.group]
                return (
                  <CommandItem
                    key={item.id}
                    value={item.id}
                    onSelect={() => onSelect(item)}
                  >
                    <Icon />
                    <span>{item.label}</span>
                    {item.value && item.value.trim() !== item.label.trim() && (
                      <CommandShortcut>{item.value}</CommandShortcut>
                    )}
                  </CommandItem>
                )
              })}
          </CommandGroup>
        ))}
      </CommandList>
    </Command>
  )
}
