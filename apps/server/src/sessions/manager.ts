import { appendMessage, createSession, getSession } from '../db/queries.js'
import type { EventBus } from '../events/bus.js'
import type { MessageContent } from '@forge/protocol/message'
import type { DatabaseSync } from 'node:sqlite'
import type { HarnessFactory, HarnessHandle, HarnessItem } from './harness.js'

type Db = DatabaseSync
type SessionRow = {
  id: string
  project_id: string
  harness: string
  cwd: string
  provider_session_id: string | null
  status: string
  title: string
  kind: string
}
const makeId = (prefix: string) =>
  `${prefix}${crypto.randomUUID().replaceAll('-', '')}`

export class SessionManager {
  private readonly handles = new Map<string, HarnessHandle>()
  private readonly reapTimers = new Map<string, ReturnType<typeof setTimeout>>()
  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly factory: HarnessFactory,
    private readonly idleMs = 15 * 60 * 1000,
  ) {}
  get database() {
    return this.db
  }

  create(input: {
    projectId: string
    harness: string
    cwd: string
    title?: string
    kind?: string
    parentSessionId?: string | null
  }) {
    return createSession(this.db, {
      ...input,
      title: input.title?.trim() || 'New session',
    })
  }

  list(projectId?: string) {
    const sql = projectId
      ? 'SELECT * FROM sessions WHERE project_id = ? ORDER BY last_activity_at DESC'
      : 'SELECT * FROM sessions ORDER BY last_activity_at DESC'
    return projectId
      ? this.db.prepare(sql).all(projectId)
      : this.db.prepare(sql).all()
  }

  private status(id: string, value: 'idle' | 'running' | 'errored') {
    this.db
      .prepare(
        'UPDATE sessions SET status = ?, last_activity_at = ? WHERE id = ?',
      )
      .run(value, Date.now(), id)
    this.bus.publishEphemeral({
      type: 'sessionStatus',
      seq: null,
      sessionId: id,
      status: value,
    })
  }

  private async spawn(row: SessionRow) {
    const onItem = (item: HarnessItem) => {
      const turnId = this.turns.get(row.id) ?? makeId('turn_')
      const normalized = item as MessageContent
      appendMessage(this.db, {
        sessionId: row.id,
        turnId,
        itemId: makeId('item_'),
        role:
          normalized.type === 'turn_start' || normalized.type === 'turn_end'
            ? 'system'
            : 'agent',
        type: normalized.type,
        content: normalized,
        eventBus: this.bus,
      })
      if (
        normalized.type === 'turn_end' ||
        normalized.type === 'turn_interrupted'
      ) {
        this.turns.delete(row.id)
        this.status(row.id, 'idle')
        this.scheduleReap(row.id)
      }
    }
    const onExit = () => {
      this.handles.delete(row.id)
      if (
        this.db.prepare('SELECT status FROM sessions WHERE id = ?').get(row.id)
      )
        this.status(row.id, 'errored')
    }
    const handle = await this.factory(row.harness).spawn(
      {
        id: row.id,
        cwd: row.cwd,
        harness: row.harness,
        providerSessionId: row.provider_session_id,
      },
      onItem,
      onExit,
    )
    this.handles.set(row.id, handle)
    this.status(row.id, 'running')
    return handle
  }
  private readonly turns = new Map<string, string>()
  private scheduleReap(id: string) {
    const old = this.reapTimers.get(id)
    if (old) clearTimeout(old)
    const timer = setTimeout(() => {
      void this.reap(id)
    }, this.idleMs)
    timer.unref?.()
    this.reapTimers.set(id, timer)
  }
  private async reap(id: string) {
    const handle = this.handles.get(id)
    if (!handle) return
    await handle.kill()
    this.handles.delete(id)
    this.reapTimers.delete(id)
    if (getSession(this.db, id)) this.status(id, 'idle')
  }
  async prompt(id: string, text: string, requestId?: string) {
    const row = getSession(this.db, id) as SessionRow | undefined
    if (!row) throw new Error('Session not found')
    if (requestId) {
      const seen = this.db
        .prepare(
          "SELECT 1 FROM messages WHERE session_id = ? AND type = 'turn_start' AND json_extract(content, '$.requestId') = ?",
        )
        .get(id, requestId)
      if (seen) return
    }
    const handle = this.handles.get(id) ?? (await this.spawn(row))
    const turnId = makeId('turn_')
    this.turns.set(id, turnId)
    appendMessage(this.db, {
      sessionId: id,
      turnId,
      itemId: makeId('item_'),
      role: 'user',
      type: 'turn_start',
      content: {
        type: 'turn_start',
        ...(requestId ? { requestId } : {}),
      } as never,
      eventBus: this.bus,
    })
    appendMessage(this.db, {
      sessionId: id,
      turnId,
      itemId: makeId('item_'),
      role: 'user',
      type: 'text_delta',
      content: { type: 'text_delta', text } as never,
      eventBus: this.bus,
    })
    try {
      await handle.prompt(text)
    } catch (error) {
      this.turns.delete(id)
      appendMessage(this.db, {
        sessionId: id,
        turnId,
        itemId: makeId('item_'),
        role: 'system',
        type: 'error',
        content: {
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        },
        eventBus: this.bus,
      })
      this.status(id, 'errored')
      throw error
    }
    // A harness may emit its own framing. Complete the turn when it does not.
    if (this.turns.get(id) === turnId) {
      appendMessage(this.db, {
        sessionId: id,
        turnId,
        itemId: makeId('item_'),
        role: 'system',
        type: 'turn_end',
        content: { type: 'turn_end' },
        eventBus: this.bus,
      })
      this.turns.delete(id)
      this.status(id, 'idle')
      this.scheduleReap(id)
    }
  }
  async interrupt(id: string) {
    await this.handles.get(id)?.cancel()
  }
  async answer(id: string, questionId: string, answer: string) {
    const row = getSession(this.db, id) as SessionRow | undefined
    if (!row) throw new Error('Session not found')
    const turnId = this.turns.get(id) ?? makeId('turn_')
    appendMessage(this.db, {
      sessionId: id,
      turnId,
      itemId: makeId('item_'),
      role: 'user',
      type: 'user_answer',
      content: { type: 'user_answer', questionId, answer },
      eventBus: this.bus,
    })
    await this.handles.get(id)?.answerQuestion?.(questionId, answer)
  }
  close() {
    for (const timer of this.reapTimers.values()) clearTimeout(timer)
    for (const handle of this.handles.values()) void handle.kill()
  }
}
