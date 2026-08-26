export type SearchScope = 'all' | 'sessions' | 'messages' | 'runs'

export type SnippetSegment = { text: string; highlighted: boolean }

/** Parse SQLite FTS snippets without allowing server text to become markup. */
export function parseSnippet(snippet: string): SnippetSegment[] {
  const segments: SnippetSegment[] = []
  let highlighted = false
  let cursor = 0
  const tags = /<\/?mark>/g
  let match: RegExpExecArray | null
  while ((match = tags.exec(snippet))) {
    if (match.index > cursor) {
      segments.push({
        text: snippet.slice(cursor, match.index),
        highlighted,
      })
    }
    highlighted = match[0] === '<mark>'
    cursor = match.index + match[0].length
  }
  if (cursor < snippet.length) {
    segments.push({ text: snippet.slice(cursor), highlighted })
  }
  return segments
}

export function sessionHitUrl(sessionId: string) {
  return `/s/${encodeURIComponent(sessionId)}`
}

export function messageHitUrl(sessionId: string, seq: number) {
  return `${sessionHitUrl(sessionId)}?m=${encodeURIComponent(String(seq))}`
}

export function runHitUrl(runId: string) {
  return `/runs/${encodeURIComponent(runId)}`
}
