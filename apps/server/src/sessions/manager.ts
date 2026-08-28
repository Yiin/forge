import { appendMessage, createSession, getSession } from '../db/queries.js'
import type { EventBus } from '../events/bus.js'
import type { MessageContent } from '@forge/protocol/message'
import type { DatabaseSync } from 'node:sqlite'
import type { HarnessFactory, HarnessHandle, HarnessItem } from './harness.js'
import { isDefaultTitle, titleFromPrompt } from './titles.js'
import { appendForkContext, createFork } from './fork.js'
import type { UploadStore } from '../uploads/store.js'
import { detectProviderError, recordLimit } from '../accounts/limits.js'

type Db = DatabaseSync
export type SessionRow = {
  id: string
  project_id: string
  harness: string
  account_id: string | null
  cwd: string
  provider_session_id: string | null
  status: string
  title: string
  kind: string
  retention?: 'permanent' | 'discardable'
  user_titled?: number
}
const makeId = (prefix: string) =>
  `${prefix}${crypto.randomUUID().replaceAll('-', '')}`

function recoveryRecap(db: Db, sessionId: string) {
  const rows = db
    .prepare(
      `SELECT role, type, content FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT 30`,
    )
    .all(sessionId) as Array<{ role: string; type: string; content: string }>
  const prompt = rows.find((row) => {
    if (row.role !== 'user' || row.type !== 'text_delta') return false
    return Boolean((JSON.parse(row.content) as { text?: string }).text)
  })
  const tools = rows.filter(
    (row) => row.type === 'tool_call' || row.type === 'tool_result',
  ).length
  return `Last user prompt: ${prompt ? (JSON.parse(prompt.content) as { text: string }).text : '(none)'}. Tool events: ${tools}.`
}

export class SessionManager {
  private readonly handles = new Map<string, HarnessHandle>()
  private readonly handleHarnesses = new Map<string, string>()
  private readonly reapTimers = new Map<string, ReturnType<typeof setTimeout>>()
  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly factory: HarnessFactory,
    private readonly idleMs = 15 * 60 * 1000,
    private readonly requiresAccount: (harness: string) => boolean = () => true,
  ) {}
  get database() {
    return this.db
  }
  liveProcessCount(harness: string) {
    let count = 0
    for (const value of this.handleHarnesses.values())
      if (value === harness) count += 1
    return count
  }
  private forgetHandle(id: string) {
    this.handles.delete(id)
    this.handleHarnesses.delete(id)
  }

  create(input: {
    projectId: string
    harness: string
    cwd: string
    title?: string
    kind?: string
    parentSessionId?: string | null
    retention?: 'permanent' | 'discardable'
    epicRunId?: string | null
    accountId?: string | null
  }) {
    const accountId = this.resolveAccount(input.harness, input.accountId)
    return createSession(this.db, {
      ...input,
      accountId,
      title: input.title?.trim() || 'New session',
      retention: input.retention,
      epicRunId: input.epicRunId,
    })
  }

  private resolveAccount(harness: string, accountId?: string | null) {
    if (accountId) {
      const row = this.db
        .prepare(
          'SELECT id FROM harness_accounts WHERE id = ? AND harness_key = ? AND disabled_at IS NULL',
        )
        .get(accountId, harness) as { id: string } | undefined
      if (!row) throw new Error('Account not found for harness')
      return row.id
    }
    const row = this.db
      .prepare(
        'SELECT id FROM harness_accounts WHERE harness_key = ? AND disabled_at IS NULL ORDER BY order_index, created_at LIMIT 1',
      )
      .get(harness) as { id: string } | undefined
    if (!row) {
      if (this.requiresAccount(harness))
        throw new Error('This harness has no account')
      return null
    }
    return row.id
  }

  private markAccountUsed(accountId: string | null) {
    if (accountId)
      this.db
        .prepare('UPDATE harness_accounts SET last_used_at = ? WHERE id = ?')
        .run(Date.now(), accountId)
  }

  list(projectId?: string, parentSessionId?: string) {
    if (parentSessionId) {
      const sql = projectId
        ? "SELECT * FROM sessions WHERE project_id = ? AND parent_session_id = ? AND retention = 'permanent' ORDER BY last_activity_at DESC"
        : "SELECT * FROM sessions WHERE parent_session_id = ? AND retention = 'permanent' ORDER BY last_activity_at DESC"
      return projectId
        ? this.db.prepare(sql).all(projectId, parentSessionId)
        : this.db.prepare(sql).all(parentSessionId)
    }
    const sql = projectId
      ? "SELECT * FROM sessions WHERE project_id = ? AND retention = 'permanent' ORDER BY last_activity_at DESC"
      : "SELECT * FROM sessions WHERE retention = 'permanent' ORDER BY last_activity_at DESC"
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
        this.maybeTitle(row.id, row.title, this.firstPrompt.get(row.id) ?? '')
        this.scheduleReap(row.id)
      }
    }
    const onExit = () => {
      this.forgetHandle(row.id)
      if (
        this.db.prepare('SELECT status FROM sessions WHERE id = ?').get(row.id)
      )
        this.status(row.id, 'errored')
    }
    this.markAccountUsed(row.account_id)
    const handle = await this.factory(row.harness, row.account_id).spawn(
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
    this.handleHarnesses.set(row.id, row.harness)
    this.status(row.id, 'running')
    return handle
  }

  canLoad(row: SessionRow) {
    const process = this.factory(row.harness, row.account_id)
    return Boolean(
      process.capabilities?.loadSession &&
      process.loadSession &&
      row.provider_session_id,
    )
  }

  async recover(row: SessionRow, recap?: string) {
    const process = this.factory(row.harness, row.account_id)
    const onItem = (item: HarnessItem) => {
      appendMessage(this.db, {
        sessionId: row.id,
        turnId: makeId('turn_'),
        itemId: makeId('item_'),
        role: 'agent',
        type: item.type,
        content: item,
        eventBus: this.bus,
      })
    }
    const onExit = () => {
      this.forgetHandle(row.id)
      this.status(row.id, 'errored')
    }
    const session = {
      id: row.id,
      cwd: row.cwd,
      harness: row.harness,
      providerSessionId: row.provider_session_id,
    }
    let result: { handle: HarnessHandle; proven: boolean }
    const canLoad =
      !recap &&
      process.capabilities?.loadSession &&
      process.loadSession &&
      row.provider_session_id
    if (canLoad) {
      try {
        result = await process.loadSession!(session, onItem, onExit)
        if (!result.proven)
          throw new Error('Provider session load was not proven')
      } catch {
        // Providers can advertise loading but lose the persisted session.
        // Fall back to a fresh session and preserve the local conversation.
        if (!process.newSession)
          throw new Error('Harness cannot create a session')
        result = await process.newSession(session, onItem, onExit)
        if (!result.proven) throw new Error('New session was not proven')
        recap = recoveryRecap(this.db, row.id)
      }
    } else {
      if (!process.newSession)
        throw new Error('Harness cannot create a session')
      result = await process.newSession(session, onItem, onExit)
      if (!result.proven) throw new Error('New session was not proven')
    }
    if (recap) {
      appendMessage(this.db, {
        sessionId: row.id,
        turnId: makeId('turn_'),
        itemId: makeId('item_'),
        role: 'system',
        type: 'error',
        content: { type: 'error', message: `resumed_with_recap: ${recap}` },
        eventBus: this.bus,
      })
    }
    this.handles.set(row.id, result.handle)
    this.handleHarnesses.set(row.id, row.harness)
    this.markAccountUsed(row.account_id)
    if (recap) await result.handle.prompt(recap)
    await result.handle.prompt('The server restarted mid-turn. Continue.')
  }
  private readonly turns = new Map<string, string>()
  private readonly firstPrompt = new Map<string, string>()
  private maybeTitle(id: string, current: string, prompt: string) {
    let row: { user_titled?: number } | undefined
    try {
      row = this.db
        .prepare('SELECT user_titled FROM sessions WHERE id = ?')
        .get(id) as { user_titled?: number } | undefined
    } catch {
      row = undefined
    }
    if (row?.user_titled || !isDefaultTitle(current) || !prompt.trim()) return
    const title = titleFromPrompt(prompt)
    this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id)
    this.bus.publishEphemeral({
      type: 'sessionTitle',
      seq: null,
      sessionId: id,
      title,
    })
  }
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
    this.forgetHandle(id)
    this.reapTimers.delete(id)
    if (getSession(this.db, id)) this.status(id, 'idle')
  }
  async prompt(
    id: string,
    text: string,
    requestId?: string,
    attachmentIds?: string[],
    harness?: string,
    accountId?: string | null,
  ) {
    let row = getSession(this.db, id) as SessionRow | undefined
    if (!row) throw new Error('Session not found')
    if (requestId) {
      const seen = this.db
        .prepare(
          "SELECT 1 FROM messages WHERE session_id = ? AND type = 'turn_start' AND json_extract(content, '$.requestId') = ?",
        )
        .get(id, requestId)
      if (seen) return
    }
    const nextHarness = harness ?? row.harness
    const nextAccount =
      accountId === undefined
        ? harness && harness !== row.harness
          ? this.resolveAccount(nextHarness)
          : row.account_id
        : this.resolveAccount(nextHarness, accountId)
    if (nextHarness !== row.harness || nextAccount !== row.account_id) {
      if (this.turns.has(id))
        throw new Error('Cannot change harness during a turn')
      const oldHandle = this.handles.get(id)
      if (oldHandle) {
        await oldHandle.kill()
        this.forgetHandle(id)
      }
      const timer = this.reapTimers.get(id)
      if (timer) clearTimeout(timer)
      this.reapTimers.delete(id)
      this.db
        .prepare(
          "UPDATE sessions SET harness = ?, account_id = ?, provider_session_id = NULL, status = 'idle', last_activity_at = ? WHERE id = ?",
        )
        .run(nextHarness, nextAccount, Date.now(), id)
      row = {
        ...row,
        harness: nextHarness,
        account_id: nextAccount,
        provider_session_id: null,
      }
    }
    const handle = this.handles.get(id) ?? (await this.spawn(row))
    const turnId = makeId('turn_')
    if (!this.firstPrompt.has(id)) this.firstPrompt.set(id, text)
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
    for (const attachmentId of attachmentIds ?? []) {
      const attachment = this.db
        .prepare(
          "SELECT id, filename, mime, size_bytes, rel_path FROM attachments WHERE id = ? AND session_id = ? AND status = 'complete'",
        )
        .get(attachmentId, id) as
        | {
            id: string
            filename: string
            mime: string
            size_bytes: number
            rel_path: string | null
          }
        | undefined
      if (attachment?.rel_path)
        appendMessage(this.db, {
          sessionId: id,
          turnId,
          itemId: makeId('item_'),
          role: 'user',
          type: 'attachment_ref',
          content: {
            type: 'attachment_ref',
            attachmentId: attachment.id,
            filename: attachment.filename,
            mime: attachment.mime,
            sizeBytes: attachment.size_bytes,
            path: attachment.rel_path,
          },
          eventBus: this.bus,
        })
    }
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
      const message = error instanceof Error ? error.message : String(error)
      const match = detectProviderError(message)
      if (match && row.account_id) {
        recordLimit(this.db, {
          accountId: row.account_id,
          kind: match.category,
          harnessKey: row.harness,
          detectedAt: Date.now(),
          source: 'session.prompt',
          detail: match.excerpt,
        })
      }
      appendMessage(this.db, {
        sessionId: id,
        turnId,
        itemId: makeId('item_'),
        role: 'system',
        type: 'error',
        content: {
          type: 'error',
          message,
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
      this.maybeTitle(id, row.title, this.firstPrompt.get(id) ?? '')
      this.scheduleReap(id)
    }
  }

  async promoteDraft(
    input: {
      draftId: string
      projectId: string
      harness: string
      text: string
      attachmentIds?: string[]
      accountId?: string | null
    },
    requestId: string,
    uploads?: UploadStore,
  ) {
    const existing = this.db
      .prepare(
        'SELECT session_id FROM draft_promotions WHERE draft_id = ? OR request_id = ?',
      )
      .get(input.draftId, requestId) as { session_id: string } | undefined
    if (existing) return { sessionId: existing.session_id }
    const project = this.db
      .prepare('SELECT path FROM projects WHERE id = ? AND archived_at IS NULL')
      .get(input.projectId) as { path: string } | undefined
    if (!project) throw new Error('Project not found')
    const session = this.create({
      projectId: input.projectId,
      harness: input.harness,
      accountId: input.accountId,
      cwd: project.path,
      title: 'New session',
    })
    try {
      try {
        this.db
          .prepare(
            'INSERT INTO draft_promotions (draft_id, request_id, session_id) VALUES (?, ?, ?)',
          )
          .run(input.draftId, requestId, session.id)
      } catch {
        await this.discard(session.id)
        const winner = this.db
          .prepare(
            'SELECT session_id FROM draft_promotions WHERE draft_id = ? OR request_id = ?',
          )
          .get(input.draftId, requestId) as { session_id: string }
        return { sessionId: winner.session_id }
      }
      if (uploads)
        await uploads.promoteDraft(input.draftId, session.id, input.projectId)
      await this.prompt(
        session.id,
        input.text,
        requestId,
        input.attachmentIds,
        input.harness,
        input.accountId,
      )
      return { sessionId: session.id }
    } catch (error) {
      if (uploads)
        await uploads.rollbackPromotion(
          input.draftId,
          session.id,
          input.projectId,
        )
      this.db
        .prepare('DELETE FROM draft_promotions WHERE session_id = ?')
        .run(session.id)
      await this.discard(session.id)
      this.db
        .prepare('DELETE FROM messages WHERE session_id = ?')
        .run(session.id)
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id)
      throw error
    }
  }
  async interrupt(id: string) {
    await this.handles.get(id)?.cancel()
  }
  async discard(id: string) {
    await this.handles.get(id)?.cancel()
    await this.handles.get(id)?.kill()
    this.forgetHandle(id)
    return Boolean(
      this.db
        .prepare(
          "UPDATE sessions SET retention = 'discardable', status = 'archived' WHERE id = ?",
        )
        .run(id).changes,
    )
  }
  keep(id: string) {
    return Boolean(
      this.db
        .prepare(
          "UPDATE sessions SET retention = 'permanent' WHERE id = ? AND retention = 'discardable'",
        )
        .run(id).changes,
    )
  }
  async fork(
    input: {
      sessionId: string
      messageSeq: number
      text: string
      requestId?: string
      includeSource: boolean
    },
    headerRequestId?: string,
  ) {
    const requestId = input.requestId ?? headerRequestId ?? crypto.randomUUID()
    const context = createFork(this.db, { ...input, requestId })
    if (context.existing)
      return {
        sessionId: context.childId,
        parentSessionId: input.sessionId,
        forkedAtSeq: context.boundary,
        contextMethod: context.method,
        contextConfidence: context.confidence,
      }
    appendForkContext(this.db, context.childId, context, this.bus)
    await this.prompt(
      context.childId,
      `${context.recap}\n\nUser request:\n${input.text}`,
      requestId,
    )
    return {
      sessionId: context.childId,
      parentSessionId: input.sessionId,
      forkedAtSeq: context.boundary,
      contextMethod: context.method,
      contextConfidence: context.confidence,
    }
  }
  async btw(input: {
    sessionId: string
    sourceSeq?: number
    text: string
    requestId?: string
  }) {
    const parent = getSession(this.db, input.sessionId) as
      SessionRow | undefined
    if (!parent) throw new Error('Session not found')
    const source =
      input.sourceSeq ??
      Number(
        (
          this.db
            .prepare(
              'SELECT MAX(seq) AS seq FROM messages WHERE session_id = ?',
            )
            .get(input.sessionId) as { seq: number | null }
        ).seq ?? 0,
      )
    if (!source) throw new Error('Side chat needs a parent message')
    const requestId = input.requestId ?? crypto.randomUUID()
    const context = createFork(this.db, {
      sessionId: input.sessionId,
      messageSeq: source,
      text: input.text,
      requestId,
      includeSource: true,
      retention: 'discardable',
    })
    if (!context.existing) {
      appendForkContext(this.db, context.childId, context, this.bus)
      await this.prompt(context.childId, input.text, requestId)
    }
    return {
      sessionId: context.childId,
      parentSessionId: input.sessionId,
      sourceSeq: context.boundary,
      retention: 'discardable' as const,
      contextMethod: context.method,
    }
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
