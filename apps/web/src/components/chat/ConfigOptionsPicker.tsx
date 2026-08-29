import { ChevronDown } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/menu'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import {
  flattenSelectOptions,
  type ConfigOption,
  type ConfigSelections,
  triggerLabel,
} from './config-options-logic'

export function ConfigOptionsPicker({
  options,
  selections,
  disabled,
  onChange,
  className,
}: {
  options: ReadonlyArray<ConfigOption>
  selections: ConfigSelections
  disabled?: boolean
  onChange: (id: string, value: string | boolean) => void
  className?: string
}) {
  if (options.length === 0) return null
  return (
    <>
      <Separator
        orientation="vertical"
        className="mx-0.5 hidden h-4 sm:block"
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled}
          aria-label="Reasoning"
          className={cn(
            buttonVariants({ variant: 'ghost', size: 'sm' }),
            className,
            'min-w-0 max-w-40 shrink-0 gap-1 px-2 text-xs text-muted-foreground/70 sm:max-w-48',
          )}
        >
          <span className="min-w-0 truncate">
            {triggerLabel(options, selections)}
          </span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {options.map((option, index) => (
            <DropdownMenuGroup key={option.id}>
              {index > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel>{option.name}</DropdownMenuLabel>
              {option.description && (
                <p className="px-2 pb-1 text-xs text-muted-foreground">
                  {option.description}
                </p>
              )}
              <DropdownMenuRadioGroup
                value={String(selections[option.id] ?? option.currentValue)}
                onValueChange={(value) =>
                  onChange(
                    option.id,
                    option.type === 'boolean' ? value === 'true' : value,
                  )
                }
              >
                {option.type === 'select'
                  ? (() => {
                      const entries = flattenSelectOptions(option)
                      return entries.flatMap((entry, entryIndex) => [
                        ...(entry.group &&
                        (entryIndex === 0 ||
                          entries[entryIndex - 1]?.group !== entry.group)
                          ? [
                              <DropdownMenuLabel
                                key={`${entry.group}-${entryIndex}`}
                                className="pt-1 text-[11px] font-normal"
                              >
                                {entry.group}
                              </DropdownMenuLabel>,
                            ]
                          : []),
                        <DropdownMenuRadioItem
                          key={entry.value}
                          value={entry.value}
                        >
                          <span className="flex min-w-0 flex-col">
                            <span>{entry.name}</span>
                            {entry.description && (
                              <span className="text-xs text-muted-foreground">
                                {entry.description}
                              </span>
                            )}
                          </span>
                        </DropdownMenuRadioItem>,
                      ])
                    })()
                  : ['true', 'false'].map((value) => (
                      <DropdownMenuRadioItem key={value} value={value}>
                        {value === 'true' ? 'On' : 'Off'}
                      </DropdownMenuRadioItem>
                    ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
