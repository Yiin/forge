/**
 * Live Markdown for the composer draft, after zeron's composer_markdown.rs.
 * The draft stays plain Markdown text; this only finds what to style and
 * computes list edits. Offsets index the whole draft.
 */

export type Mark =
  | 'strong'
  | 'em'
  | 'strike'
  | 'code'
  | 'fence'
  | 'heading'
  /** Markdown syntax: `**`, backticks, `#`, fence lines. */
  | 'delim'
  /** A list bullet or number. */
  | 'list'
  /** A picked `@file` or `$skill`, shown as a chip. */
  | 'mention'

export type Segment = { start: number; end: number; marks: Mark[] }
export type DraftLine = {
  start: number
  end: number
  /** Inside a fenced code block, fence lines included. */
  fence: boolean
  segments: Segment[]
}
export type Mentions = {
  files?: ReadonlySet<string>
  skills?: ReadonlySet<string>
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const HEADING = /^ {0,3}#{1,6}(?:[ \t]+|$)/
const LIST = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(\[[ xX]\][ \t]+)?/
/** Characters a mention may follow, besides whitespace (zeron 7.1). */
const MENTION_BOUNDARY = /[\s([{>]/
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/
const SKILL_NAME = /^[a-zA-Z][\w:-]*/

const isSpace = (char: string | undefined) =>
  char === undefined || /\s/.test(char)
const isWord = (char: string | undefined) =>
  char !== undefined && /[\p{L}\p{N}]/u.test(char)

type Match =
  | { kind: 'code'; open: number; close: number; end: number }
  | { kind: 'mention'; end: number }
  | {
      kind: 'strong' | 'em' | 'strike'
      open: number
      close: number
      end: number
    }

/** The first closing run of `delimiter` after `from` that can close. */
function closer(
  line: string,
  from: number,
  to: number,
  delimiter: string,
  intraword: boolean,
) {
  const char = delimiter[0]!
  for (
    let index = line.indexOf(delimiter, from);
    index >= 0 && index + delimiter.length <= to;
    index = line.indexOf(delimiter, index + 1)
  ) {
    const before = line[index - 1]
    const after = line[index + delimiter.length]
    if (isSpace(before)) continue
    // A single `*` beside another is part of a `**` run, not a closer.
    if (delimiter.length === 1 && (before === char || after === char)) continue
    if (!intraword && isWord(after)) continue
    return index
  }
  return -1
}

function matchAt(
  line: string,
  index: number,
  to: number,
  mentions: Mentions,
): Match | null {
  const char = line[index]!
  if (char === '`') {
    let run = 1
    while (line[index + run] === '`') run += 1
    const fence = '`'.repeat(run)
    for (
      let close = line.indexOf(fence, index + run);
      close >= 0 && close + run <= to;
      close = line.indexOf(fence, close + 1)
    ) {
      if (line[close + run] === '`' || line[close - 1] === '`') continue
      return {
        kind: 'code',
        open: index + run,
        close,
        end: close + run,
      }
    }
    return null
  }
  if (char === '@' || char === '$') {
    if (index > 0 && !MENTION_BOUNDARY.test(line[index - 1]!)) return null
    let end = index + 1
    while (end < to && !/\s/.test(line[end]!)) end += 1
    let token = line.slice(index + 1, end)
    if (char === '$') token = SKILL_NAME.exec(token)?.[0] ?? ''
    const known = char === '@' ? mentions.files : mentions.skills
    for (let name = token; name;) {
      if (known?.has(name))
        return { kind: 'mention', end: index + 1 + name.length }
      const trimmed = name.replace(TRAILING_PUNCTUATION, '')
      if (trimmed === name) break
      name = trimmed
    }
    return null
  }
  const pairs: Array<['strong' | 'strike' | 'em', string]> =
    char === '*'
      ? [
          ['strong', '**'],
          ['em', '*'],
        ]
      : char === '_'
        ? [
            ['strong', '__'],
            ['em', '_'],
          ]
        : char === '~'
          ? [['strike', '~~']]
          : []
  for (const [kind, delimiter] of pairs) {
    if (!line.startsWith(delimiter, index)) continue
    const open = index + delimiter.length
    if (isSpace(line[open]) || open >= to) continue
    // `_` does not open or close inside a word, so snake_case stays text.
    const intraword = char !== '_'
    if (!intraword && isWord(line[index - 1])) continue
    const close = closer(line, open + 1, to, delimiter, intraword)
    if (close < 0) continue
    return { kind, open, close, end: close + delimiter.length }
  }
  return null
}

function inline(
  line: string,
  base: number,
  from: number,
  to: number,
  marks: Mark[],
  out: Segment[],
  mentions: Mentions,
) {
  let text = from
  const push = (start: number, end: number, extra: Mark[] = []) => {
    if (end > start)
      out.push({
        start: base + start,
        end: base + end,
        marks: [...marks, ...extra],
      })
  }
  for (let index = from; index < to;) {
    if (line[index] === '\\' && index + 1 < to) {
      index += 2
      continue
    }
    const match = matchAt(line, index, to, mentions)
    if (!match) {
      index += 1
      continue
    }
    push(text, index)
    if (match.kind === 'mention') push(index, match.end, ['mention'])
    else if (match.kind === 'code') {
      push(index, match.open, ['code', 'delim'])
      push(match.open, match.close, ['code'])
      push(match.close, match.end, ['code', 'delim'])
    } else {
      push(index, match.open, ['delim'])
      inline(
        line,
        base,
        match.open,
        match.close,
        [...marks, match.kind],
        out,
        mentions,
      )
      push(match.close, match.end, ['delim'])
    }
    index = match.end
    text = index
  }
  push(text, to)
}

/** Split the draft into lines of styled segments. */
export function parseDraft(text: string, mentions: Mentions = {}): DraftLine[] {
  const lines: DraftLine[] = []
  let fence: { char: string; length: number } | undefined
  let start = 0
  for (const line of text.split('\n')) {
    const end = start + line.length
    const segments: Segment[] = []
    const opener = FENCE.exec(line)
    if (fence) {
      const closing =
        opener &&
        opener[1]![0] === fence.char &&
        opener[1]!.length >= fence.length &&
        !line.slice(opener[0].length).trim()
      if (line)
        segments.push({
          start,
          end,
          marks: closing ? ['fence', 'delim'] : ['fence'],
        })
      lines.push({ start, end, fence: true, segments })
      if (closing) fence = undefined
    } else if (opener) {
      fence = { char: opener[1]![0]!, length: opener[1]!.length }
      segments.push({ start, end, marks: ['fence', 'delim'] })
      lines.push({ start, end, fence: true, segments })
    } else {
      const heading = HEADING.exec(line)
      const list = heading ? null : LIST.exec(line)
      let body = 0
      const marks: Mark[] = heading ? ['heading'] : []
      if (heading) {
        body = heading[0].length
        segments.push({ start, end: start + body, marks: ['heading', 'delim'] })
      } else if (list) {
        body = list[0].length
        const bullet = list[1]!.length
        if (bullet) segments.push({ start, end: start + bullet, marks: [] })
        segments.push({
          start: start + bullet,
          end: start + body,
          marks: ['list'],
        })
      }
      inline(line, start, body, line.length, marks, segments, mentions)
      lines.push({ start, end, fence: false, segments })
    }
    start = end + 1
  }
  return lines
}

/** A mention that ends exactly at `offset`, so Backspace takes it whole. */
export function mentionBefore(
  text: string,
  offset: number,
  mentions: Mentions,
): { start: number; end: number } | undefined {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1
  const lineEnd = text.indexOf('\n', offset)
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd)
  const [parsed] = parseDraft(line, mentions)
  const hit = parsed?.segments.find(
    (segment) =>
      segment.marks.includes('mention') && lineStart + segment.end === offset,
  )
  return hit && { start: lineStart + hit.start, end: offset }
}

export type DraftEdit = {
  /** Replace `start..end` of the draft with `text`. */
  start: number
  end: number
  text: string
  /** Where the caret lands after the edit. */
  caret: number
}

/**
 * Shift+Enter inside a list item: continue the list on a new line, with the
 * next number and an open task box. On an empty item it ends the list
 * instead, clearing the bullet. Anything else is a plain newline (null).
 */
export function continueList(
  text: string,
  selectionStart: number,
  selectionEnd: number,
): DraftEdit | null {
  const lineStart = text.lastIndexOf('\n', selectionStart - 1) + 1
  const list = LIST.exec(text.slice(lineStart, selectionStart))
  if (!list) return null
  const [marker, indent, bullet, gap, task] = list as unknown as [
    string,
    string,
    string,
    string,
    string | undefined,
  ]
  const lineEnd = text.indexOf('\n', selectionEnd)
  const rest = text.slice(
    lineStart + marker.length,
    lineEnd < 0 ? text.length : lineEnd,
  )
  if (!rest.trim() && selectionStart === selectionEnd)
    return {
      start: lineStart,
      end: lineStart + marker.length,
      text: '',
      caret: lineStart,
    }
  const number = /^(\d+)([.)])$/.exec(bullet)
  const next = number ? `${Number(number[1]) + 1}${number[2]}` : bullet
  const insert = `\n${indent}${next}${gap}${task ? '[ ] ' : ''}`
  return {
    start: selectionStart,
    end: selectionEnd,
    text: insert,
    caret: selectionStart + insert.length,
  }
}

const INDENT = '  '

/**
 * Tab or Shift+Tab with the caret or selection in list items: indent or
 * outdent every selected line by two spaces. Null when the lines are not a
 * list, so Tab keeps moving focus.
 */
export function indentList(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  outdent: boolean,
): (DraftEdit & { selection: [number, number] }) | null {
  const start = text.lastIndexOf('\n', selectionStart - 1) + 1
  // A selection that ends at the start of a line leaves that line alone.
  const last =
    selectionEnd > selectionStart && text[selectionEnd - 1] === '\n'
      ? selectionEnd - 1
      : selectionEnd
  const found = text.indexOf('\n', last)
  const end = found < 0 ? text.length : found
  const lines = text.slice(start, end).split('\n')
  if (!lines.every((line) => LIST.test(line) || !line.trim())) return null
  if (!lines.some((line) => LIST.test(line))) return null
  let before = 0
  let removedFirst = 0
  const next = lines.map((line, index) => {
    if (!LIST.test(line)) return line
    if (!outdent) {
      before += INDENT.length
      if (index === 0) removedFirst = -INDENT.length
      return INDENT + line
    }
    const lead = /^(?: {1,2}|\t)/.exec(line)?.[0].length ?? 0
    before -= lead
    if (index === 0) removedFirst = lead
    return line.slice(lead)
  })
  const replaced = next.join('\n')
  if (replaced === text.slice(start, end)) return null
  const selection: [number, number] = [
    Math.max(start, selectionStart - removedFirst),
    Math.max(start, selectionEnd + before),
  ]
  return {
    start,
    end,
    text: replaced,
    caret: selection[1],
    selection,
  }
}
