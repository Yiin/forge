export type ShortcutCommand = {
  id: string
  key: string
  label: string
  ariaKeyshortcuts: string
  action: () => void
}

export const shortcutDefinitions = [
  ['palette.open', 'mod+k', 'Open command palette'],
  ['sidebar.toggle', 'mod+\\', 'Toggle sidebar'],
  ['navigate.chat', 'g c', 'Go to Chat'],
  ['navigate.runs', 'g r', 'Go to Runs'],
  ['navigate.files', 'g f', 'Go to Files'],
  ['navigate.settings', 'g s', 'Go to Settings'],
  ['session.new', 'n', 'New session'],
  ['session.previous', 'alt+arrowup', 'Previous session'],
  ['session.next', 'alt+arrowdown', 'Next session'],
  ['session.rename', 'f2', 'Rename session'],
  ['session.menu', 'shift+f10', 'Open item menu'],
  ['session.stop', 'mod+.', 'Stop run'],
  ['help.shortcuts', '?', 'Show keyboard shortcuts'],
] as const
export type ShortcutId = (typeof shortcutDefinitions)[number][0]
export type ShortcutOverrides = Partial<Record<ShortcutId, string>>

const commands = new Map<string, ShortcutCommand>()
let chord: string | null = null
let chordTimer: number | undefined
let overrides: ShortcutOverrides = {}
export function setShortcutOverrides(next: ShortcutOverrides) {
  overrides = { ...next }
}
export function shortcutDefault(id: ShortcutId) {
  return shortcutDefinitions.find((item) => item[0] === id)?.[1] ?? ''
}
export function shortcutKey(id: ShortcutId) {
  return overrides[id] ?? shortcutDefault(id)
}
export function displayShortcut(key: string, platform = navigator.platform) {
  const modifier = /Mac|iPhone|iPad/.test(platform) ? '⌘' : 'Ctrl'
  return key
    .split(' ')
    .map((part) =>
      part
        .split('+')
        .map((token) =>
          token === 'mod' ? modifier : token[0]?.toUpperCase() + token.slice(1),
        )
        .join('+'),
    )
    .join('  ')
}

export function registerShortcuts(
  actions: Partial<Record<(typeof shortcutDefinitions)[number][0], () => void>>,
) {
  const added: string[] = []
  for (const [id, , label] of shortcutDefinitions) {
    const action = actions[id]
    if (!action) continue
    const key = shortcutKey(id)
    commands.set(id, {
      id,
      key,
      label,
      ariaKeyshortcuts: displayShortcut(key),
      action,
    })
    added.push(id)
  }
  return () => added.forEach((id) => commands.delete(id))
}

export function shortcutCommands() {
  return [...commands.values()].map((command) => ({
    ...command,
    key: shortcutKey(command.id as ShortcutId),
    ariaKeyshortcuts: displayShortcut(shortcutKey(command.id as ShortcutId)),
  }))
}

export function executeShortcut(id: string) {
  commands.get(id)?.action()
}

function editable(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null
  return !!element?.closest('input, textarea, select, [contenteditable="true"]')
}

function modal(target: EventTarget | null) {
  return (
    target instanceof HTMLElement && !!target.closest('[role="dialog"], dialog')
  )
}

function keyFor(event: KeyboardEvent) {
  const key = event.key.toLowerCase()
  if (event.metaKey || event.ctrlKey) return `mod+${key}`
  if (event.altKey) return `alt+${key}`
  if (event.shiftKey && key === 'f10') return 'shift+f10'
  return key
}

export function handleShortcut(event: KeyboardEvent) {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    editable(event.target) ||
    modal(event.target)
  )
    return false
  const key = keyFor(event)
  if (chord === 'g') {
    chord = null
    window.clearTimeout(chordTimer)
    const command = [...commands.values()].find(
      (item) => shortcutKey(item.id as ShortcutId) === `g ${key}`,
    )
    if (!command) return false
    event.preventDefault()
    command.action()
    return true
  }
  if (key === 'g') {
    chord = 'g'
    chordTimer = window.setTimeout(() => (chord = null), 1000)
    return true
  }
  const command = [...commands.values()].find(
    (item) => shortcutKey(item.id as ShortcutId) === key,
  )
  if (!command) return false
  event.preventDefault()
  command.action()
  return true
}

export function resetShortcutRegistry() {
  commands.clear()
  overrides = {}
  chord = null
}
