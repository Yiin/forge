/**
 * Flattens thinking markdown into short styled lines, the way zeron shows an
 * expanded "Thought process": no block layout, one fixed-height line each,
 * wrapped at 96 columns, links shown but not clickable.
 */

export type ThoughtSpan = {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
  strike?: boolean
  link?: boolean
}
export type ThoughtLine = ThoughtSpan[]

export const THOUGHT_WRAP = 96
export const THOUGHT_MAX_LINES = 24

const INLINE =
  /(\*\*|__)(.+?)\1|`([^`]+)`|~~(.+?)~~|\[([^\]]+)\]\([^)]*\)|(\*|_)(?!\s)(.+?)(?<!\s)\6/g

function inline(text: string, base: Omit<ThoughtSpan, 'text'> = {}) {
  const spans: ThoughtSpan[] = []
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0
    if (index > last) spans.push({ ...base, text: text.slice(last, index) })
    if (match[2] !== undefined)
      spans.push(...inline(match[2], { ...base, bold: true }))
    else if (match[3] !== undefined)
      spans.push({ ...base, text: match[3], code: true })
    else if (match[4] !== undefined)
      spans.push(...inline(match[4], { ...base, strike: true }))
    else if (match[5] !== undefined)
      spans.push({ ...base, text: match[5], link: true })
    else if (match[7] !== undefined)
      spans.push(...inline(match[7], { ...base, italic: true }))
    last = index + match[0].length
  }
  if (last < text.length) spans.push({ ...base, text: text.slice(last) })
  return spans
}

function wrap(spans: ThoughtSpan[], width = THOUGHT_WRAP): ThoughtLine[] {
  const lines: ThoughtLine[] = [[]]
  let used = 0
  for (const span of spans) {
    for (const word of span.text.split(/(\s+)/)) {
      if (!word) continue
      const space = /^\s+$/.test(word)
      if (!space && used + word.length > width && used > 0) {
        lines.push([])
        used = 0
      }
      if (space && used === 0) continue
      const line = lines.at(-1)!
      const previous = line.at(-1)
      const text = space ? ' ' : word
      if (previous && sameStyle(previous, span)) previous.text += text
      else line.push({ ...span, text })
      used += text.length
    }
  }
  return lines
}

function sameStyle(a: ThoughtSpan, b: ThoughtSpan) {
  return (
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.code === !!b.code &&
    !!a.strike === !!b.strike &&
    !!a.link === !!b.link
  )
}

export function thoughtLines(markdown: string): ThoughtLine[] {
  const source = markdown.replace(/\r\n?/g, '\n').split('\n')
  const lines: ThoughtLine[] = []
  let fenced = false
  let blank = false
  let previousList = false
  const push = (spans: ThoughtSpan[], list = false) => {
    if (blank && lines.length && !(list && previousList)) lines.push([])
    blank = false
    previousList = list
    lines.push(...wrap(spans))
  }
  source.forEach((raw, index) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced
      return
    }
    if (fenced) {
      if (blank && lines.length) lines.push([])
      blank = false
      lines.push([{ text: raw, code: true }])
      return
    }
    const line = raw.trimEnd()
    if (!line.trim()) {
      blank = true
      return
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line)
    if (heading) return push(inline(heading[1], { bold: true }))
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line))
      return push([{ text: '———' }])
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) return push([{ text: '│ ' }, ...inline(quote[1])])
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (bullet)
      return push(
        [
          { text: `${bullet[1]}• ` },
          ...inline(bullet[2].replace(/^\[[ xX]\]\s*/, '')),
        ],
        true,
      )
    const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line)
    if (ordered)
      return push(
        [{ text: `${ordered[1]}${ordered[2]}. ` }, ...inline(ordered[3])],
        true,
      )
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) return
      const header = /^\s*\|[\s:|-]+\|\s*$/.test(source[index + 1] ?? '')
      const cells = line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => cell.trim())
      const spans = cells.flatMap((cell, cellIndex) => [
        ...(cellIndex ? [{ text: ' · ', bold: header }] : []),
        ...inline(cell, header ? { bold: true } : {}),
      ])
      return push(spans, true)
    }
    push(inline(line.trim()))
  })
  return lines
}

/**
 * Keeps the fresh end of a live thought and the start of a settled one, so
 * the reader sees what the agent is thinking now, then how it began.
 */
export function capThoughtLines(lines: ThoughtLine[], live: boolean) {
  if (lines.length <= THOUGHT_MAX_LINES) return { lines, hidden: 0 }
  const hidden = lines.length - THOUGHT_MAX_LINES
  return {
    lines: live
      ? lines.slice(-THOUGHT_MAX_LINES)
      : lines.slice(0, THOUGHT_MAX_LINES),
    hidden,
  }
}
