import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { Check, ChevronRight, Search, Star, Terminal } from 'lucide-react'
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover'
import { HarnessMark } from '@/components/settings/HarnessMark'
import { harnessMarkKind } from '@/components/settings/harness-mark-logic'
import type { Account } from '@/lib/accounts-api'
import { cn } from '@/lib/utils'
import {
  accountChoices,
  selectHarness,
  type HarnessOption,
  type HarnessSelection,
} from '../chat/harness-picker-logic'
import {
  filterModels,
  modelChipName,
  type ModelOption,
} from '../chat/model-picker-logic'
import {
  currentLabel,
  flattenSelectOptions,
  pendingChanges,
  type ConfigOption,
  type ConfigSelections,
} from '../chat/config-options-logic'
import { CARD_CLASS, CARD_VIEWPORT_CLASS, MENU_ROW_CLASS } from './zeron-styles'
import { EDGE_FADE_CLASS, useEdgeFade } from './useEdgeFade'

export type HarnessEntry = {
  key: string
  name?: string
  command?: string
  args?: string[]
}

type Choice = {
  value: string
  label: string
  detail?: string
  group?: string
  disabled?: boolean
}
type TrayRow = {
  key: string
  label: string
  value: string
  current: string
  choices: Choice[]
  disabled?: boolean
  pick: (value: string) => void
}

const isMac = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/** Brand kind for a harness: its account kind, else its launch command. */
function markKind(
  harness: string,
  entries: ReadonlyArray<HarnessEntry>,
  accounts: ReadonlyArray<Account>,
) {
  const account = accounts.find((item) => item.harness === harness)
  if (account) return account.kind
  const entry = entries.find((item) => item.key === harness)
  return harnessMarkKind(harness, entry)
}

/**
 * zeron's model chip: brand mark, model name and a muted effort suffix in one
 * trigger. Its popover holds the agent tabs, the model list, and a tray with
 * the account and the harness config options (reasoning and the like).
 */
export function ModelChip({
  harnessOptions,
  harnessEntries,
  accounts,
  loaded,
  selection,
  models,
  modelsLoading,
  configOptions,
  configSelections,
  configDisabled,
  hero,
  open,
  onOpenChange,
  returnFocus,
  onSelectionChange,
  onConfigChange,
}: {
  harnessOptions: HarnessOption[]
  harnessEntries: ReadonlyArray<HarnessEntry>
  accounts: ReadonlyArray<Account>
  loaded: boolean
  selection: HarnessSelection
  models: ModelOption[]
  modelsLoading: boolean
  configOptions: ConfigOption[]
  configSelections: ConfigSelections
  configDisabled: boolean
  hero: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  returnFocus: RefObject<HTMLTextAreaElement | null>
  onSelectionChange: (selection: HarnessSelection) => void
  onConfigChange: (id: string, value: string | boolean) => void
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const [heldWidth, setHeldWidth] = useState<number | undefined>(undefined)
  const noAgents = loaded && harnessOptions.length === 0
  const harnessLabel =
    harnessOptions.find((option) => option.harness === selection.harness)
      ?.label ??
    harnessEntries.find((entry) => entry.key === selection.harness)?.name ??
    selection.harness
  const name = modelChipName(selection.model, models, harnessLabel || 'Agent')
  const traits = configOptions
    .map((option) => currentLabel(option, configSelections))
    .join(' · ')
  const traitsChanged =
    Object.keys(pendingChanges(configOptions, configSelections)).length > 0
  const kind = selection.harness
    ? markKind(selection.harness, harnessEntries, accounts)
    : ''
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // Hold the chip's width while open so a label change does not move
        // the popover under the pointer.
        setHeldWidth(next ? trigger.current?.offsetWidth : undefined)
        onOpenChange(next)
      }}
    >
      <PopoverTrigger
        render={
          <button
            ref={trigger}
            type="button"
            aria-label="Model"
            style={heldWidth ? { width: heldWidth } : undefined}
            className={cn(
              'group/chip relative inline-flex h-8 max-w-[248px] min-w-0 cursor-pointer items-center gap-1.5 rounded-[8px] px-1.5 text-[12px] font-medium outline-none transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:bg-accent data-popup-open:bg-accent pointer-coarse:after:absolute pointer-coarse:after:-inset-1.5 pointer-coarse:after:content-[""]',
              name.set && !noAgents
                ? 'text-foreground/90'
                : 'text-muted-foreground',
            )}
          />
        }
      >
        {noAgents ? (
          <>
            <Terminal
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground"
            />
            <span className="truncate">No agents available</span>
          </>
        ) : (
          <>
            {kind && (
              <HarnessMark
                kind={kind}
                className={cn(kind !== 'claude' && 'text-muted-foreground')}
              />
            )}
            <span className="min-w-0 truncate">{name.label}</span>
            {traits && (
              <span
                className={cn(
                  'min-w-0 shrink-[1000] truncate transition-colors duration-150',
                  traitsChanged
                    ? 'text-foreground/85'
                    : 'text-muted-foreground',
                )}
              >
                {traits}
              </span>
            )}
          </>
        )}
      </PopoverTrigger>
      <PopoverPopup
        side={hero ? 'bottom' : 'top'}
        align="end"
        sideOffset={6}
        initialFocus={search}
        finalFocus={returnFocus}
        className={cn(CARD_CLASS, 'w-[304px] max-w-[calc(100vw-16px)] p-0')}
        viewportClassName={cn(
          CARD_VIEWPORT_CLASS,
          'overflow-visible not-data-transitioning:overflow-visible',
        )}
      >
        {noAgents ? (
          <div className="flex flex-col items-center gap-2 p-4 text-center">
            <Terminal aria-hidden className="size-5 text-muted-foreground" />
            <p className="text-[13px] text-foreground">No agents available</p>
            <p className="text-[12px] text-muted-foreground">
              Enable an agent in Settings, or{' '}
              <a
                href="/settings/accounts"
                className="text-foreground underline-offset-2 hover:underline"
              >
                Add an account
              </a>
              .
            </p>
          </div>
        ) : (
          <ModelCard
            search={search}
            harnessOptions={harnessOptions}
            harnessEntries={harnessEntries}
            accounts={accounts}
            selection={selection}
            models={models}
            modelsLoading={modelsLoading}
            configOptions={configOptions}
            configSelections={configSelections}
            configDisabled={configDisabled}
            onSelectionChange={onSelectionChange}
            onConfigChange={onConfigChange}
          />
        )}
      </PopoverPopup>
    </Popover>
  )
}

function ModelCard({
  search,
  harnessOptions,
  harnessEntries,
  accounts,
  selection,
  models,
  modelsLoading,
  configOptions,
  configSelections,
  configDisabled,
  onSelectionChange,
  onConfigChange,
}: {
  search: RefObject<HTMLInputElement | null>
  harnessOptions: HarnessOption[]
  harnessEntries: ReadonlyArray<HarnessEntry>
  accounts: ReadonlyArray<Account>
  selection: HarnessSelection
  models: ModelOption[]
  modelsLoading: boolean
  configOptions: ConfigOption[]
  configSelections: ConfigSelections
  configDisabled: boolean
  onSelectionChange: (selection: HarnessSelection) => void
  onConfigChange: (id: string, value: string | boolean) => void
}) {
  const [query, setQuery] = useState('')
  const card = useRef<HTMLDivElement>(null)
  const list = useEdgeFade<HTMLDivElement>()
  const trayRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const visible = filterModels(models, query)
  const option = harnessOptions.find(
    (item) => item.harness === selection.harness,
  )
  const accountRows = option ? accountChoices(option) : []
  const tray: TrayRow[] = [
    ...(option && accountRows.length > 1
      ? [
          {
            key: 'account',
            label: 'Account',
            current: selection.accountId ?? '',
            value:
              accountRows.find(
                (row) => (row.accountId ?? '') === (selection.accountId ?? ''),
              )?.label ?? 'Choose',
            choices: accountRows.map((row) => ({
              value: row.accountId ?? '',
              label: row.label,
              detail: row.coolingLabel
                ? `Cooling, ${row.coolingLabel}`
                : undefined,
              disabled: row.disabled,
            })),
            pick: (value: string) =>
              onSelectionChange({
                ...selection,
                harness: option.harness,
                accountId: value || undefined,
              }),
          },
        ]
      : []),
    ...configOptions.map((config) => ({
      key: `config:${config.id}`,
      label: config.name,
      current: String(configSelections[config.id] ?? config.currentValue),
      value: currentLabel(config, configSelections),
      disabled: configDisabled,
      choices:
        config.type === 'select'
          ? flattenSelectOptions(config).map((entry) => ({
              value: entry.value,
              label: entry.name,
              detail: entry.description,
              group: entry.group,
            }))
          : [
              { value: 'true', label: 'On' },
              { value: 'false', label: 'Off' },
            ],
      pick: (value: string) =>
        onConfigChange(
          config.id,
          config.type === 'boolean' ? value === 'true' : value,
        ),
    })),
  ]
  const selectedIndex = visible.findIndex(
    (model) => model.id === selection.model,
  )
  const [cursor, setCursor] = useState(selectedIndex)
  const [submenu, setSubmenu] = useState<{
    key: string
    cursor: number
    side: 'left' | 'right'
    top: number
  } | null>(null)
  const total = visible.length + tray.length
  useEffect(() => {
    list.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [cursor, list])

  const pickModel = (model: ModelOption) =>
    onSelectionChange({ ...selection, model: model.id })
  const openSubmenu = (row: TrayRow) => {
    if (row.disabled) return
    const node = trayRefs.current[row.key]
    const box = card.current?.getBoundingClientRect()
    const side =
      box && box.right + 10 + 232 > window.innerWidth - 8 ? 'left' : 'right'
    const at = row.choices.findIndex((choice) => choice.value === row.current)
    setSubmenu({
      key: row.key,
      cursor: Math.max(0, at),
      side,
      top: node?.offsetTop ?? 0,
    })
  }
  const activeRow = submenu
    ? tray.find((row) => row.key === submenu.key)
    : undefined
  const step = (length: number, from: number, delta: 1 | -1) =>
    length === 0
      ? -1
      : from < 0
        ? delta > 0
          ? 0
          : length - 1
        : (from + delta + length) % length

  const onKeyDown = (event: KeyboardEvent) => {
    const down =
      event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')
    const up = event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')
    if (submenu && activeRow) {
      if (down || up) {
        event.preventDefault()
        setSubmenu({
          ...submenu,
          cursor: step(activeRow.choices.length, submenu.cursor, down ? 1 : -1),
        })
      } else if (event.key === 'Enter') {
        event.preventDefault()
        const choice = activeRow.choices[submenu.cursor]
        if (choice && !choice.disabled) activeRow.pick(choice.value)
        setSubmenu(null)
      } else if (event.key === 'Escape' || event.key === 'ArrowLeft') {
        event.preventDefault()
        event.stopPropagation()
        setSubmenu(null)
      }
      return
    }
    if (down || up) {
      event.preventDefault()
      setCursor(step(total, cursor, down ? 1 : -1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (cursor >= 0 && cursor < visible.length) pickModel(visible[cursor]!)
      else if (cursor >= visible.length) {
        const row = tray[cursor - visible.length]
        if (row) openSubmenu(row)
      }
    } else if (event.key === 'ArrowRight' && cursor >= visible.length) {
      event.preventDefault()
      const row = tray[cursor - visible.length]
      if (row) openSubmenu(row)
    } else if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
      const model = visible[Number(event.key) - 1]
      if (model) {
        event.preventDefault()
        pickModel(model)
      }
    }
  }

  const trayHeight = Math.min(tray.length * 32 + 7, 236)
  return (
    <div
      ref={card}
      className="relative flex w-full flex-col"
      onKeyDown={onKeyDown}
    >
      {harnessOptions.length > 0 && (
        <div
          role="tablist"
          aria-label="Agents"
          className="flex h-10 shrink-0 items-center gap-0.5 border-b border-ink/8 px-1"
        >
          {harnessOptions.map((item) => {
            const active = item.harness === selection.harness
            return (
              <button
                key={item.harness}
                type="button"
                role="tab"
                aria-selected={active}
                aria-label={item.label}
                title={item.label}
                onClick={() => {
                  setCursor(-1)
                  setSubmenu(null)
                  onSelectionChange(
                    selectHarness(harnessOptions, item.harness, selection),
                  )
                }}
                className={cn(
                  'relative grid size-8 shrink-0 cursor-pointer place-items-center rounded-[7px] outline-none transition-colors duration-150 hover:bg-ink/6 focus-visible:bg-ink/6',
                  active ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                <HarnessMark
                  kind={markKind(item.harness, harnessEntries, accounts)}
                />
                {active && (
                  <span
                    aria-hidden
                    className="absolute inset-x-1.5 -bottom-1 h-0.5 rounded-[1px] bg-primary"
                  />
                )}
              </button>
            )
          })}
        </div>
      )}
      <label className="flex h-10 shrink-0 items-center gap-2 border-b border-ink/8 px-2.5">
        <Search aria-hidden className="size-3.5 text-muted-foreground" />
        <input
          ref={search}
          aria-label="Search models"
          placeholder="Search models…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setCursor(event.target.value.trim() ? 0 : -1)
          }}
          className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-foreground outline-none placeholder:text-faint-foreground"
        />
      </label>
      <div
        ref={list}
        role="listbox"
        aria-label="Models"
        className={cn(
          'flex h-[216px] flex-col gap-0.5 overflow-y-auto bg-ink/2 p-1',
          EDGE_FADE_CLASS,
        )}
      >
        {modelsLoading && models.length === 0 ? (
          Array.from({ length: 4 }, (_, index) => (
            <div
              key={index}
              aria-hidden
              className="h-7 shrink-0 animate-pulse rounded-[6px] bg-ink/4"
              style={{ animationDelay: `${index * 80}ms` }}
            />
          ))
        ) : visible.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-faint-foreground">
            {models.length === 0
              ? 'This session does not expose model choices'
              : 'No models found'}
          </p>
        ) : (
          visible.map((model, index) => {
            const selected = model.id === selection.model
            const detail = model.description ?? model.traits?.join(' · ')
            return (
              <div
                key={model.id}
                role="option"
                aria-selected={selected}
                data-active={index === cursor}
                onMouseEnter={() => {
                  setCursor(index)
                  setSubmenu(null)
                }}
                onClick={() => pickModel(model)}
                className={cn(
                  'flex min-h-8 shrink-0 cursor-pointer items-center gap-2.5 rounded-[7px] px-2 py-[5px] transition-colors duration-150',
                  selected
                    ? 'bg-wash/11 inset-ring-1 inset-ring-ink/9 not-dark:bg-wash/6 not-dark:inset-ring-ink/7'
                    : 'data-[active=true]:bg-ink/5',
                )}
              >
                <span className="flex min-w-0 flex-1 items-baseline gap-2">
                  <span className="truncate text-[12.5px] font-medium text-foreground">
                    {model.label}
                  </span>
                  {detail && (
                    <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                      {detail}
                    </span>
                  )}
                </span>
                {index < 9 && (
                  <span className="shrink-0 rounded-[5px] bg-ink/5 px-[5px] py-px font-mono text-[10px] text-muted-foreground">
                    {isMac() ? `⌘${index + 1}` : `Ctrl ${index + 1}`}
                  </span>
                )}
                {model.favorite && (
                  <Star
                    aria-label="Default model"
                    className="size-[13px] shrink-0 fill-current text-warning"
                  />
                )}
              </div>
            )
          })
        )}
      </div>
      {tray.length > 0 && (
        <div
          className="flex shrink-0 flex-col gap-0.5 overflow-y-auto border-t border-ink/8 p-1"
          style={{ maxHeight: trayHeight }}
        >
          {tray.map((row, index) => (
            <button
              key={row.key}
              ref={(node) => {
                trayRefs.current[row.key] = node
              }}
              type="button"
              aria-haspopup="menu"
              aria-expanded={submenu?.key === row.key}
              disabled={row.disabled}
              data-active={
                submenu?.key === row.key || cursor === visible.length + index
              }
              onMouseEnter={() => {
                setCursor(visible.length + index)
                if (submenu && submenu.key !== row.key) setSubmenu(null)
              }}
              onClick={() =>
                submenu?.key === row.key ? setSubmenu(null) : openSubmenu(row)
              }
              className={cn(MENU_ROW_CLASS, 'h-[30px] py-0')}
            >
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
              <span className="max-w-[100px] truncate text-muted-foreground">
                {row.value}
              </span>
              <ChevronRight
                aria-hidden
                className="size-3 shrink-0 text-muted-foreground"
              />
            </button>
          ))}
        </div>
      )}
      {submenu && activeRow && (
        <div
          role="menu"
          aria-label={activeRow.label}
          className={cn(
            CARD_CLASS,
            'absolute z-10 flex max-h-[240px] w-[232px] flex-col gap-0.5 overflow-y-auto duration-150 animate-in fade-in-0 motion-reduce:animate-none',
            submenu.side === 'right'
              ? 'left-[calc(100%+10px)]'
              : 'right-[calc(100%+10px)]',
          )}
          style={{ top: Math.max(0, submenu.top - 4) }}
        >
          {activeRow.choices.map((choice, index) => {
            const heading =
              choice.group &&
              (index === 0 ||
                activeRow.choices[index - 1]?.group !== choice.group)
            return (
              <div key={choice.value} className="contents">
                {heading && (
                  <p className="px-2 pt-1.5 pb-1 text-[10px] font-medium tracking-[0.1em] text-muted-foreground uppercase">
                    {choice.group}
                  </p>
                )}
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={choice.value === activeRow.current}
                  disabled={choice.disabled}
                  data-active={index === submenu.cursor}
                  onMouseEnter={() => setSubmenu({ ...submenu, cursor: index })}
                  onClick={() => {
                    activeRow.pick(choice.value)
                    setSubmenu(null)
                    search.current?.focus()
                  }}
                  className={cn(MENU_ROW_CLASS, 'min-h-[30px] py-1')}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{choice.label}</span>
                    {choice.detail && (
                      <span className="truncate text-[11px] text-muted-foreground">
                        {choice.detail}
                      </span>
                    )}
                  </span>
                  {choice.value === activeRow.current && (
                    <Check aria-hidden className="size-3.5 shrink-0" />
                  )}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
