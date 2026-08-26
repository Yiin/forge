import { appendMessage, createSession, getSession } from '../db/queries.js'
import type { DatabaseSync } from 'node:sqlite'

export type ForkContext = {
  childId: string
  boundary: number
  method: 'synthetic'
  confidence: 'reduced'
  recap: string
  existing: boolean
}

type Row = {
  id: string
  project_id: string
  harness: string
  cwd: string
  title: string
}

function textFor(row: { type: string; content: string }) {
  if (row.type !== 'text_delta' && row.type !== 'thought_delta') return ''
  try {
    const content = JSON.parse(row.content) as { text?: string }
    return content.text ?? ''
  } catch {
    return ''
  }
}

export function createFork(
  db: DatabaseSync,
  input: {
    sessionId: string
    messageSeq: number
    text: string
    requestId: string
    includeSource: boolean
    retention?: 'permanent' | 'discardable'
  },
): ForkContext {
  const parent = getSession(db, input.sessionId) as Row | undefined
  if (!parent) throw new Error('Session not found')
  const source = db
    .prepare('SELECT seq FROM messages WHERE session_id = ? AND seq = ?')
    .get(input.sessionId, input.messageSeq)
  if (!source) throw new Error('Fork boundary is not in this session')
  const boundary = input.includeSource ? input.messageSeq : input.messageSeq - 1
  const existing = db
    .prepare(
      'SELECT id, forked_at_seq, context_method, context_confidence FROM sessions WHERE parent_session_id = ? AND fork_request_id = ?',
    )
    .get(input.sessionId, input.requestId) as
    | {
        id: string
        forked_at_seq: number
        context_method: 'synthetic'
        context_confidence: 'reduced'
      }
    | undefined
  if (existing) {
    const rows = db
      .prepare(
        'SELECT type, content FROM messages WHERE session_id = ? AND seq <= ? ORDER BY seq',
      )
      .all(input.sessionId, boundary) as Array<{
      type: string
      content: string
    }>
    return {
      childId: existing.id,
      boundary: existing.forked_at_seq,
      method: existing.context_method,
      confidence: existing.context_confidence,
      recap: recap(rows),
      existing: true,
    }
  }
  const child = createSession(db, {
    projectId: parent.project_id,
    harness: parent.harness,
    cwd: parent.cwd,
    title: `Fork of ${parent.title}`,
    parentSessionId: parent.id,
    forkedAtSeq: boundary,
    forkRequestId: input.requestId,
    contextMethod: 'synthetic',
    contextConfidence: 'reduced',
    retention: input.retention,
  })
  const rows = db
    .prepare(
      'SELECT type, content FROM messages WHERE session_id = ? AND seq <= ? ORDER BY seq',
    )
    .all(input.sessionId, boundary) as Array<{ type: string; content: string }>
  return {
    childId: child.id,
    boundary,
    method: 'synthetic',
    confidence: 'reduced',
    recap: recap(rows),
    existing: false,
  }
}

function recap(rows: Array<{ type: string; content: string }>) {
  const text = rows.map(textFor).filter(Boolean).join('\n')
  return text
    ? `Conversation context:\n${text}`
    : 'Conversation context: (empty)'
}

export function appendForkContext(
  db: DatabaseSync,
  childId: string,
  context: ForkContext,
  bus: Parameters<typeof appendMessage>[1]['eventBus'],
) {
  appendMessage(db, {
    sessionId: childId,
    turnId: `fork_${crypto.randomUUID()}`,
    itemId: `fork_context_${crypto.randomUUID()}`,
    role: 'system',
    type: 'error',
    content: {
      type: 'error',
      message: 'Synthetic context · reduced confidence',
    },
    eventBus: bus,
  })
}
