export type ShortcutCommand = {
  id: string
  key: string
  label: string
  ariaKeyshortcuts: string
  action: () => void
}

export const shortcutDefinitions = [
  ['palette.open', 'mod+k', 'Open command palette', 'Meta+K'],
  ['sidebar.toggle', 'mod+\\', 'Toggle sidebar', 'Meta+\\'],
  ['navigate.chat', 'g c', 'Go to Chat', 'G C'],
  ['navigate.runs', 'g r', 'Go to Runs', 'G R'],
  ['navigate.files', 'g f', 'Go to Files', 'G F'],
  ['navigate.settings', 'g s', 'Go to Settings', 'G S'],
  ['session.new', 'n', 'New session', 'N'],
  ['session.previous', 'alt+arrowup', 'Previous session', 'Alt+ArrowUp'],
  ['session.next', 'alt+arrowdown', 'Next session', 'Alt+ArrowDown'],
  ['session.rename', 'f2', 'Rename session', 'F2'],
  ['session.menu', 'shift+f10', 'Open item menu', 'Shift+F10'],
  ['session.stop', 'mod+.', 'Stop run', 'Meta+.'],
  ['help.shortcuts', '?', 'Show keyboard shortcuts', '?'],
] as const

const commands = new Map<string, ShortcutCommand>()
let chord: string | null = null
let chordTimer: number | undefined

export function registerShortcuts(
  actions: Partial<Record<(typeof shortcutDefinitions)[number][0], () => void>>,
) {
  const added: string[] = []
  for (const [id, key, label, ariaKeyshortcuts] of shortcutDefinitions) {
    const action = actions[id]
    if (!action) continue
    commands.set(id, { id, key, label, ariaKeyshortcuts, action })
    added.push(id)
  }
  return () => added.forEach((id) => commands.delete(id))
}

export function shortcutCommands() {
  return [...commands.values()]
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
  if (event.isComposing || editable(event.target) || modal(event.target))
    return false
  const key = keyFor(event)
  if (chord === 'g') {
    chord = null
    window.clearTimeout(chordTimer)
    const command = [...commands.values()].find(
      (item) => item.key === `g ${key}`,
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
  const command = [...commands.values()].find((item) => item.key === key)
  if (!command) return false
  event.preventDefault()
  command.action()
  return true
}

export function resetShortcutRegistry() {
  commands.clear()
  chord = null
}
