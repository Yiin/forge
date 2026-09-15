import type { DatabaseSync } from 'node:sqlite'
import type { HarnessEvent } from '../harnesses/types.js'
import type { HarnessItem } from './harness.js'
import type { EventBus } from '../events/bus.js'
import {
  appendMessageInTransaction,
  publishAppendedMessage,
} from '../db/queries.js'

type RequestEvent = Extract<
  HarnessEvent,
  { type: 'permission_requested' | 'question_requested' }
>
type Entry = {
  sessionId: string
  event: RequestEvent
  state: 'pending' | 'replying'
  prepare: (answer: unknown, cancelled: boolean) => () => Promise<void>
}
export class NativeInteractionError extends Error {
  constructor(
    readonly status: 400 | 409 | 410 | 500,
    message: string,
  ) {
    super(message)
  }
}
/** Holds only original native request callbacks. The provider owns request expiry. */
export class NativeInteractions {
  private readonly held = new Map<string, Entry>()
  constructor(
    private readonly db: DatabaseSync,
    private readonly bus: EventBus,
  ) {}
  owns(sessionId: string, requestId: string) {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM native_interactions WHERE session_id=? AND request_id=? AND json_extract(request,'$.native')=1",
        )
        .get(sessionId, requestId),
    )
  }
  register(
    sessionId: string,
    event: RequestEvent,
    content: HarnessItem,
    prepare: Entry['prepare'],
  ) {
    const key = JSON.stringify([sessionId, event.request.requestId])
    if (this.held.has(key)) throw Error('Duplicate native request')
    if (
      this.held.size >= 256 ||
      [...this.held.values()].filter((e) => e.sessionId === sessionId).length >=
        64
    )
      throw Error('Native request capacity reached')
    const captured = structuredClone(event)
    const now = Date.now()
    const publicRequest = {
      ...content,
      native: true,
      questionId: event.request.requestId,
      sessionId: sessionId,
      questions:
        'questions' in content && Array.isArray(content.questions)
          ? content.questions
          : [],
      source: event.type === 'permission_requested' ? 'permission' : 'ext',
    }
    this.db.exec('BEGIN')
    let saved
    try {
      this.db
        .prepare(
          `INSERT INTO native_interactions(request_id,session_id,runtime_generation,kind,request,status,created_at,updated_at,expires_at)
        VALUES(?,?,?,?,?,'pending',?,?,?)`,
        )
        .run(
          event.request.requestId,
          sessionId,
          event.runtimeGeneration,
          event.type === 'permission_requested' ? 'permission' : 'question',
          JSON.stringify(publicRequest),
          now,
          now,
          Number.MAX_SAFE_INTEGER,
        )
      saved = appendMessageInTransaction(this.db, {
        sessionId: sessionId,
        turnId: event.turnId,
        itemId: event.itemId,
        role: 'agent',
        type: 'ask_user_question',
        content,
      })
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.held.set(key, {
      sessionId,
      event: captured,
      state: 'pending',
      prepare,
    })
    publishAppendedMessage(this.bus, saved)
  }
  async answerQuestion(
    sessionId: string,
    requestId: string,
    input: unknown,
    cancelled = false,
  ) {
    const key = JSON.stringify([sessionId, requestId]),
      entry = this.held.get(key)
    if (!entry)
      throw new NativeInteractionError(
        410,
        'Native request is no longer pending',
      )
    if (entry.state !== 'pending')
      throw new NativeInteractionError(
        409,
        'Native reply is already in progress',
      )
    const body =
      input && typeof input === 'object'
        ? (input as Record<string, unknown>)
        : { answer: input }
    const answer = body.answers ?? body.answer
    let send: () => Promise<void>
    try {
      send = entry.prepare(answer, cancelled)
    } catch {
      throw new NativeInteractionError(400, 'Invalid native request answer')
    }
    // Persist admission before invoking the original native callback.
    const changed = this.db
      .prepare(
        "UPDATE native_interactions SET status='replying',updated_at=? WHERE session_id=? AND request_id=? AND runtime_generation=? AND status='pending'",
      )
      .run(Date.now(), sessionId, requestId, entry.event.runtimeGeneration)
    if (changed.changes !== 1)
      throw new NativeInteractionError(410, 'Native request ownership changed')
    entry.state = 'replying'
    try {
      await send()
    } catch (error) {
      this.held.delete(key)
      try {
        this.db
          .prepare(
            "UPDATE native_interactions SET status='uncertain',updated_at=? WHERE session_id=? AND request_id=? AND runtime_generation=? AND status='replying'",
          )
          .run(Date.now(), sessionId, requestId, entry.event.runtimeGeneration)
      } catch (persistence) {
        throw new AggregateError(
          [error, persistence],
          'Native reply and persistence failed',
        )
      }
      throw error
    }
    this.held.delete(key)
    const persisted =
      entry.event.type === 'question_requested' &&
      entry.event.request.questions.some((q) => q.isSecret)
        ? '[redacted]'
        : answer
    this.db.exec('BEGIN')
    let saved
    try {
      const result = this.db
        .prepare(
          "UPDATE native_interactions SET status=?,answer=?,updated_at=? WHERE session_id=? AND request_id=? AND runtime_generation=? AND status='replying'",
        )
        .run(
          cancelled ? 'cancelled' : 'submitted',
          JSON.stringify(persisted ?? null),
          Date.now(),
          sessionId,
          requestId,
          entry.event.runtimeGeneration,
        )
      if (result.changes !== 1)
        throw Error('Native reply ownership changed during delivery')
      saved = appendMessageInTransaction(this.db, {
        sessionId,
        turnId: entry.event.turnId,
        itemId: crypto.randomUUID(),
        role: 'user',
        type: 'user_answer',
        content: {
          type: 'user_answer',
          questionId: requestId,
          ...(cancelled ? { cancelled: true } : { answers: persisted }),
        },
      })
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.held.delete(key)
    publishAppendedMessage(this.bus, saved)
    return cancelled ? { cancelled: true } : { answer: persisted }
  }
  cancelQuestion(sessionId: string, requestId: string) {
    return this.answerQuestion(sessionId, requestId, undefined, true)
  }
  retire(generation: string, requestId?: string) {
    for (const [key, entry] of this.held) {
      if (
        entry.event.runtimeGeneration !== generation ||
        (requestId && entry.event.request.requestId !== requestId)
      )
        continue
      if (entry.state === 'replying') continue
      this.db.exec('BEGIN')
      let saved
      try {
        this.db
          .prepare(
            "UPDATE native_interactions SET status='expired',updated_at=? WHERE session_id=? AND request_id=? AND runtime_generation=? AND status='pending'",
          )
          .run(
            Date.now(),
            entry.sessionId,
            entry.event.request.requestId,
            generation,
          )
        saved = appendMessageInTransaction(this.db, {
          sessionId: entry.sessionId,
          turnId: entry.event.turnId,
          itemId: crypto.randomUUID(),
          role: 'user',
          type: 'user_answer',
          content: {
            type: 'user_answer',
            questionId: entry.event.request.requestId,
            expired: true,
          },
        })
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
      this.held.delete(key)
      publishAppendedMessage(this.bus, saved)
    }
  }
}
