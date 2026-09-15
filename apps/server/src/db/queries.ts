import { z } from 'zod'
import { messageContentTypes } from '@forge/protocol/message'
import type { EventBus } from '../events/bus.js'

// The wire schema in @forge/protocol carries a committed seq and an ISO
// createdAt. Rows are validated before insert, when neither exists yet, so the
// row shape is validated here and the type enum stays shared.
const messageRowSchema = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string().min(1),
  role: z.enum(['user', 'agent', 'system']),
  type: z.enum(messageContentTypes),
  content: z.unknown(),
  createdAt: z.number().int(),
})
type Db = { exec(sql: string): unknown; prepare(sql: string): any }
const id = (prefix: string) =>
  `${prefix}${Date.now().toString(36)}${crypto.randomUUID().replaceAll('-', '')}`
const json = (value: unknown) => JSON.stringify(value)

export type AppendMessage = {
  sessionId: string
  turnId: string
  itemId: string
  role: 'user' | 'agent' | 'system'
  type: string
  content: unknown
  createdAt?: number
  eventBus?: EventBus
}

type SavedMessage = ReturnType<typeof messageRowSchema.parse> & { seq: number }

function insertMessage(db: Db, input: AppendMessage): SavedMessage {
  const parsed = messageRowSchema.parse({
    ...input,
    createdAt: input.createdAt ?? Date.now(),
  })
  const result = db
    .prepare(
      `INSERT INTO messages
      (session_id, turn_id, item_id, role, type, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      parsed.sessionId,
      parsed.turnId,
      parsed.itemId,
      parsed.role,
      parsed.type,
      json(parsed.content),
      parsed.createdAt,
    )
  const seq = Number(result.lastInsertRowid)
  db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?').run(
    parsed.createdAt,
    parsed.sessionId,
  )
  return { ...parsed, seq }
}

export function publishAppendedMessage(
  eventBus: EventBus | undefined,
  saved: SavedMessage,
) {
  if (!eventBus) return
  eventBus?.publishPersisted({
    seq: saved.seq,
    sessionId: saved.sessionId,
    msg: {
      seq: saved.seq,
      sessionId: saved.sessionId,
      turnId: saved.turnId,
      itemId: saved.itemId,
      role: saved.role,
      type: saved.type,
      content: saved.content as never,
      createdAt: new Date(saved.createdAt).toISOString(),
    },
  })
}

export function appendMessageInTransaction(db: Db, input: AppendMessage) {
  return insertMessage(db, input)
}

export function appendMessage(db: Db, input: AppendMessage) {
  let saved: SavedMessage
  db.exec('BEGIN')
  try {
    saved = insertMessage(db, input)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  publishAppendedMessage(input.eventBus, saved)
  return saved
}

export function replaySince(
  db: Db,
  cursor: number,
  sessionIds: string[] | 'all',
  limit = 500,
) {
  if (sessionIds === 'all')
    return db
      .prepare('SELECT * FROM messages WHERE seq > ? ORDER BY seq LIMIT ?')
      .all(cursor, limit)
  if (!sessionIds.length) return []
  const marks = sessionIds.map(() => '?').join(',')
  return db
    .prepare(
      `SELECT * FROM messages WHERE seq > ? AND session_id IN (${marks}) ORDER BY seq LIMIT ?`,
    )
    .all(cursor, ...sessionIds, limit)
}

export function createProject(
  db: Db,
  input: { name: string; path: string; now?: number },
) {
  const value = {
    id: id('prj_'),
    name: input.name,
    path: input.path,
    createdAt: input.now ?? Date.now(),
  }
  db.prepare(
    'INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)',
  ).run(value.id, value.name, value.path, value.createdAt)
  return value
}
export function createSession(
  db: Db,
  input: {
    projectId?: string | null
    harness: string
    title: string
    cwd: string
    worktreePath?: string | null
    branch?: string | null
    kind?: string
    retention?: 'permanent' | 'discardable'
    parentSessionId?: string | null
    forkedAtSeq?: number | null
    forkRequestId?: string | null
    contextMethod?: string | null
    contextConfidence?: string | null
    epicRunId?: string | null
    accountId?: string | null
    now?: number
  },
) {
  if (input.projectId && !getProject(db, input.projectId))
    throw new Error('Project not found')
  const now = input.now ?? Date.now()
  const value = { id: id('ses_'), ...input, kind: input.kind ?? 'chat', now }
  db.prepare(
    `INSERT INTO sessions (id, project_id, harness, title, cwd, worktree_path, branch, kind, retention, parent_session_id, forked_at_seq, fork_request_id, context_method, context_confidence, epic_run_id, account_id, status, auto_resume, created_at, last_activity_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', 0, ?, ?)`,
  ).run(
    value.id,
    value.projectId ?? null,
    value.harness,
    value.title,
    value.cwd,
    input.worktreePath ?? null,
    input.branch ?? null,
    value.kind,
    input.retention ?? 'permanent',
    value.parentSessionId ?? null,
    input.forkedAtSeq ?? null,
    input.forkRequestId ?? null,
    input.contextMethod ?? null,
    input.contextConfidence ?? null,
    input.epicRunId ?? null,
    input.accountId ?? null,
    now,
    now,
  )
  return value
}
export const listSessions = (db: Db, projectId?: string) =>
  projectId
    ? db
        .prepare(
          "SELECT * FROM sessions WHERE project_id = ? AND deleted_at IS NULL AND retention = 'permanent' ORDER BY last_activity_at DESC",
        )
        .all(projectId)
    : db
        .prepare(
          "SELECT * FROM sessions WHERE deleted_at IS NULL AND retention = 'permanent' ORDER BY last_activity_at DESC",
        )
        .all()
export const getProject = (db: Db, projectId: string) =>
  db
    .prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL')
    .get(projectId)
export const getSession = (db: Db, sessionId: string) =>
  db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId)
export const getActiveSession = (db: Db, sessionId: string) =>
  db
    .prepare(
      `SELECT sessions.* FROM sessions LEFT JOIN projects ON projects.id = sessions.project_id
       WHERE sessions.id = ? AND sessions.deleted_at IS NULL AND (sessions.project_id IS NULL OR projects.deleted_at IS NULL)`,
    )
    .get(sessionId)

export function createRun(
  db: Db,
  input: {
    projectId: string
    epicBeadId: string
    status: string
    mode: string
    workerCount: number
    baseBranch: string
    config: unknown
    originSessionId: string | null
    startedAt?: number
  },
) {
  const value = {
    id: id('run_'),
    ...input,
    startedAt: input.startedAt ?? Date.now(),
  }
  db.prepare(
    `INSERT INTO epic_runs (id, project_id, epic_bead_id, status, mode, worker_count, base_branch, config, origin_session_id, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    value.id,
    value.projectId,
    value.epicBeadId,
    value.status,
    value.mode,
    value.workerCount,
    value.baseBranch,
    json(value.config),
    value.originSessionId,
    value.startedAt,
  )
  return { ...value, endedAt: null, error: null }
}
export function updateRunStatus(
  db: Db,
  runId: string,
  status: string,
  error?: string | null,
) {
  db.prepare(
    'UPDATE epic_runs SET status = ?, ended_at = ?, error = ? WHERE id = ?',
  ).run(
    status,
    ['completed', 'failed', 'cancelled'].includes(status) ? Date.now() : null,
    error ?? null,
    runId,
  )
}
export function updateRunConfig(db: Db, runId: string, config: unknown) {
  db.prepare('UPDATE epic_runs SET config = ? WHERE id = ?').run(
    json(config),
    runId,
  )
}
export function createIteration(
  db: Db,
  input: {
    runId: string
    beadId: string
    sessionId: string
    worktreePath: string
    branch: string
    attempt?: number
    harness?: string | null
    model?: string | null
    accountId?: string | null
  },
) {
  const value = {
    id: id('itr_'),
    ...input,
    attempt: input.attempt ?? 1,
    startedAt: Date.now(),
  }
  db.prepare(
    `INSERT INTO epic_iterations (id, epic_run_id, bead_id, session_id, worktree_path, branch, attempt, harness, model, account_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
  ).run(
    value.id,
    value.runId,
    value.beadId,
    value.sessionId,
    value.worktreePath,
    value.branch,
    value.attempt,
    value.harness ?? null,
    value.model ?? null,
    value.accountId ?? null,
    value.startedAt,
  )
  return value
}
export function settleIteration(
  db: Db,
  iterationId: string,
  status: string,
  failureReason?: string,
) {
  db.prepare(
    'UPDATE epic_iterations SET status = ?, failure_reason = ?, ended_at = ? WHERE id = ?',
  ).run(status, failureReason ?? null, Date.now(), iterationId)
}
export const listActiveRuns = (db: Db) =>
  db
    .prepare(
      "SELECT * FROM epic_runs WHERE status IN ('running', 'paused') ORDER BY started_at",
    )
    .all()
export function runWithIterations(db: Db, runId: string) {
  const run = db.prepare('SELECT * FROM epic_runs WHERE id = ?').get(runId)
  return run
    ? {
        run,
        iterations: db
          .prepare(
            'SELECT * FROM epic_iterations WHERE epic_run_id = ? ORDER BY started_at',
          )
          .all(runId),
      }
    : undefined
}
