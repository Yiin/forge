export type ComposerTriggerKind = 'slash-command' | 'skill' | 'path'

export type ComposerTrigger = {
  kind: ComposerTriggerKind
  query: string
  rangeStart: number
  rangeEnd: number
}

export function detectComposerTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = Math.max(0, Math.min(text.length, cursorInput))
  const lineStart = text.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1
  const linePrefix = text.slice(lineStart, cursor)
  if (linePrefix.startsWith('/')) {
    const match = /^\/(\S*)$/.exec(linePrefix)
    if (match)
      return { kind: 'slash-command', query: match[1] ?? '', rangeStart: lineStart, rangeEnd: cursor }
  }
  const before = text.slice(0, cursor)
  const tokenStart = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\n'), before.lastIndexOf('\t')) + 1
  const token = text.slice(tokenStart, cursor)
  if (token.startsWith('$') && !/[\w]$/.test(text[tokenStart - 1] ?? ''))
    return { kind: 'skill', query: token.slice(1), rangeStart: tokenStart, rangeEnd: cursor }
  if (token.startsWith('@'))
    return { kind: 'path', query: token.slice(1), rangeStart: tokenStart, rangeEnd: cursor }
  return null
}

export function replaceComposerTrigger(text: string, trigger: ComposerTrigger, replacement: string) {
  const next = `${text.slice(0, trigger.rangeStart)}${replacement}${text.slice(trigger.rangeEnd)}`
  return { text: next, cursor: trigger.rangeStart + replacement.length }
}
