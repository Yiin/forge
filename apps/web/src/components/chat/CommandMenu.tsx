import { useEffect, useImperativeHandle, useState } from 'react'
import type { Ref } from 'react'
import { File, SquareSlash, WandSparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ComposerTriggerKind } from './composer-triggers'
import { emptyCommandText, filterComposerCommands } from './command-menu-logic'
import { CARD_CLASS, MENU_ROW_CLASS } from '../composer/zeron-styles'
import { EDGE_FADE_CLASS, useEdgeFade } from '../composer/useEdgeFade'

export type ComposerCommand = {
  id: string
  label: string
  group: 'Built-in' | 'Harness' | 'Skills' | 'Files'
  value?: string
  /** Muted text after the label: a description or a path. */
  detail?: string
}

/** Keyboard hooks the composer input drives while the menu is open. */
export type CommandMenuHandle = {
  move: (delta: 1 | -1) => void
  /** Accepts the highlighted row. Returns false when there is none. */
  accept: () => boolean
}

const groupIcons: Record<ComposerCommand['group'], typeof File> = {
  'Built-in': SquareSlash,
  Harness: SquareSlash,
  Skills: WandSparkles,
  Files: File,
}

/**
 * The `/`, `$` and `@` completion card. It spans the pill's width above it;
 * focus stays in the composer, which moves the highlight through `ref`.
 */
export function CommandMenu({
  ref,
  commands,
  kind,
  query,
  onSelect,
}: {
  ref?: Ref<CommandMenuHandle>
  commands: ComposerCommand[]
  kind: ComposerTriggerKind | null
  query: string
  onSelect: (command: ComposerCommand) => void
}) {
  const rows = filterComposerCommands(commands, kind, query)
  const [active, setActive] = useState(0)
  const list = useEdgeFade<HTMLDivElement>()
  useEffect(() => setActive(0), [query, kind])
  useEffect(() => {
    list.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [active, list])
  useImperativeHandle(
    ref,
    () => ({
      move: (delta) =>
        setActive((current) =>
          rows.length === 0 ? 0 : (current + delta + rows.length) % rows.length,
        ),
      accept: () => {
        const row = rows[active]
        if (!row) return false
        onSelect(row)
        return true
      },
    }),
    [rows, active, onSelect],
  )
  return (
    <div
      data-composer-menu=""
      className={cn(
        CARD_CLASS,
        'flex max-h-80 min-h-0 flex-col duration-150 animate-in fade-in-0 slide-in-from-bottom-0.5 motion-reduce:animate-none',
      )}
      // Keep focus (and the caret) in the composer while clicking a row.
      onMouseDown={(event) => event.preventDefault()}
    >
      <div
        ref={list}
        role="listbox"
        aria-label="Completions"
        className={cn(
          'flex max-h-[310px] min-h-0 flex-col gap-0.5 overflow-y-auto',
          EDGE_FADE_CLASS,
        )}
      >
        {rows.length === 0 ? (
          <p className="px-3 py-2.5 text-[12px] text-muted-foreground">
            {emptyCommandText(commands, kind)}
          </p>
        ) : (
          rows.map((row, index) => {
            const Icon = groupIcons[row.group]
            return (
              <div
                key={row.id}
                role="option"
                aria-selected={index === active}
                data-active={index === active}
                onMouseEnter={() => setActive(index)}
                onClick={() => onSelect(row)}
                className={cn(MENU_ROW_CLASS, 'gap-2')}
              >
                <span className="grid size-4 shrink-0 place-items-center text-muted-foreground">
                  <Icon aria-hidden className="size-4" />
                </span>
                <span
                  className={cn(
                    'truncate font-medium text-foreground',
                    row.detail && 'max-w-[55%]',
                  )}
                >
                  {row.label}
                </span>
                {row.detail && (
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">
                    {row.detail}
                  </span>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
