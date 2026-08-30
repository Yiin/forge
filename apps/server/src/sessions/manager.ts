import { appendMessage, createSession, getSession } from '../db/queries.js'
import type { EventBus } from '../events/bus.js'
import type { DatabaseSync } from 'node:sqlite'
import type {
  HarnessFactory,
  HarnessHandle,
  HarnessItem,
  HarnessModel,
} from './harness.js'
import { isDefaultTitle, titleFromPrompt } from './titles.js'
import { appendForkContext, createFork } from './fork.js'
import type { UploadStore } from '../uploads/store.js'
import { detectProviderError, recordLimit } from '../accounts/limits.js'
import { errorMessage } from '../error-message.js'
import { gitStatus } from '../git/repo.js'
import {
  deleteMergedTemporaryBranch,
  listWorktrees,
  provisionWorktree,
  removeWorktree,
  WorktreeRemovalError,
} from '../git/worktrees.js'
import type { WorkspaceChoice } from '@forge/protocol/commands'

type Db = DatabaseSync
export type SessionRow = {
  id: string
  project_id: string
  harness: string
  account_id: string | null
  cwd: string
  provider_session_id: string | null
  model: string | null
  config_options?: string | null
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
  private readonly availableModels = new Map<string, HarnessModel[]>()
  private readonly handleHarnesses = new Map<string, string>()
  private readonly reapTimers = new Map<string, ReturnType<typeof setTimeout>>()
  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly factory: HarnessFactory,
    private readonly idleMs = 15 * 60 * 1000,
    private readonly requiresAccount: (harness: string) => boolean = () => true,
    private readonly dataDir = process.env.FORGE_DATA_DIR ?? 'data',
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
    this.availableModels.delete(id)
    this.handleHarnesses.delete(id)
  }
  models(id: string) {
    return this.availableModels.get(id) ?? []
  }
  configOptions(id: string) {
    return this.handles.get(id)?.configOptions?.() ?? []
  }
  private rememberModels(id: string, models?: HarnessModel[]) {
    if (models) this.availableModels.set(id, models)
  }

  create(input: {
    projectId: string
    harness: string
    cwd: string
    worktreePath?: string | null
    branch?: string | null
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
      worktreePath: input.worktreePath,
      branch: input.branch,
    })
  }

  async resolveWorkspace(
    projectId: string,
    projectPath: string,
    workspace?: WorkspaceChoice,
  ) {
    const status = await gitStatus(projectPath)
    if (!workspace || workspace.mode === 'local') {
      return {
        cwd: projectPath,
        worktreePath: null,
        branch: status.branch,
      }
    }
    const worktree = await provisionWorktree({
      repoPath: projectPath,
      dataDir: this.dataDir,
      projectId,
      baseRef:
        workspace.baseRef ?? status.defaultBranch ?? status.branch ?? 'HEAD',
      branch: workspace.branch,
    })
    return {
      cwd: worktree.path,
      worktreePath: worktree.path,
      branch: worktree.branch,
    }
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
      const turnId = item.turnId ?? this.turns.get(row.id) ?? makeId('turn_')
      const itemId = item.itemId ?? makeId('item_')
      const { itemId: _itemId, turnId: _turnId, ...normalized } = item
      appendMessage(this.db, {
        sessionId: row.id,
        turnId,
        itemId,
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
    this.rememberModels(row.id, handle.availableModels)
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
    const fallbackTurnId = makeId('turn_')
    const onItem = (item: HarnessItem) => {
      const { itemId: _itemId, turnId: _turnId, ...content } = item
      appendMessage(this.db, {
        sessionId: row.id,
        turnId: item.turnId ?? fallbackTurnId,
        itemId: item.itemId ?? makeId('item_'),
        role: 'agent',
        type: item.type,
        content,
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
    let result: {
      handle: HarnessHandle
      proven: boolean
      availableModels?: HarnessModel[]
    }
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
    this.rememberModels(
      row.id,
      result.availableModels ?? result.handle.availableModels,
    )
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
  private async acceptPrompt(
    id: string,
    text: string,
    requestId?: string,
    attachmentIds?: string[],
    harness?: string,
    accountId?: string | null,
    model?: string,
    clientItemId?: string,
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
      itemId: clientItemId ?? makeId('item_'),
      role: 'user',
      type: 'text_delta',
      content: { type: 'text_delta', text } as never,
      eventBus: this.bus,
    })
    this.status(id, 'running')
    return { row, turnId, model }
  }

  async prompt(
    id: string,
    text: string,
    requestId?: string,
    attachmentIds?: string[],
    harness?: string,
    accountId?: string | null,
    model?: string,
    clientItemId?: string,
    configOptions?: Record<string, string | boolean>,
  ) {
    const accepted = await this.acceptPrompt(
      id,
      text,
      requestId,
      attachmentIds,
      harness,
      accountId,
      model,
      clientItemId,
    )
    if (!accepted) return
    // Startup errors become timeline errors after acceptance. This keeps the
    // user row visible and leaves the session reachable for inspection.
    void (async () => {
      const handle =
        this.handles.get(accepted.row.id) ?? (await this.spawn(accepted.row))
      let row = accepted.row
      if (accepted.model !== undefined && accepted.model !== row.model) {
        if (!handle.setModel)
          throw new Error('Harness does not support model selection')
        await handle.setModel(accepted.model)
        this.db
          .prepare('UPDATE sessions SET model = ? WHERE id = ?')
          .run(accepted.model, row.id)
        row = { ...row, model: accepted.model }
      }
      if (configOptions && Object.keys(configOptions).length > 0) {
        if (!handle.setConfigOption || !handle.configOptions)
          throw new Error('Harness does not support config options')
        const live = new Map(
          handle.configOptions().map((option) => [option.id, option]),
        )
        const stored = parseConfigOptions(row.config_options)
        const merged = { ...stored }
        for (const key of Object.keys(configOptions).sort()) {
          const value = configOptions[key]
          if (!live.has(key)) {
            delete merged[key]
            continue
          }
          if (stored[key] !== value) {
            await handle.setConfigOption(key, value)
            merged[key] = value
          }
        }
        this.db
          .prepare('UPDATE sessions SET config_options = ? WHERE id = ?')
          .run(JSON.stringify(merged), row.id)
        row = { ...row, config_options: JSON.stringify(merged) }
      }
      this.runPrompt(handle, row, accepted.turnId, text)
    })().catch((error: unknown) =>
      this.failPrompt(accepted.row, accepted.turnId, error),
    )
  }

  private runPrompt(
    handle: HarnessHandle,
    row: SessionRow,
    turnId: string,
    text: string,
  ) {
    try {
      const result = handle.prompt(text)
      if (result && typeof result === 'object' && 'then' in result)
        void Promise.resolve(result).then(
          () => this.finishPrompt(row, turnId),
          (error: unknown) => this.failPrompt(row, turnId, error),
        )
      else this.finishPrompt(row, turnId)
    } catch (error) {
      this.failPrompt(row, turnId, error)
    }
  }

  private failPrompt(row: SessionRow, turnId: string, error: unknown) {
    this.turns.delete(row.id)
    const message = errorMessage(error)
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
      sessionId: row.id,
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
    this.status(row.id, 'errored')
  }

  private finishPrompt(row: SessionRow, turnId: string) {
    // A harness may emit its own framing. Complete the turn when it does not.
    if (this.turns.get(row.id) === turnId) {
      appendMessage(this.db, {
        sessionId: row.id,
        turnId,
        itemId: makeId('item_'),
        role: 'system',
        type: 'turn_end',
        content: { type: 'turn_end' },
        eventBus: this.bus,
      })
      this.turns.delete(row.id)
      this.status(row.id, 'idle')
      this.maybeTitle(row.id, row.title, this.firstPrompt.get(row.id) ?? '')
      this.scheduleReap(row.id)
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
      model?: string
      clientItemId?: string
      workspace?: WorkspaceChoice
    },
    requestId: string,
    uploads?: UploadStore,
  ) {
    // Idempotency keys on the promotion attempt (requestId), never on the
    // draft id: drafts are reused across sessions, so a draft-scoped lookup
    // would return a previous session and silently drop the new prompt.
    const existing = this.db
      .prepare('SELECT session_id FROM draft_promotions WHERE request_id = ?')
      .get(requestId) as { session_id: string } | undefined
    if (existing) return { sessionId: existing.session_id }
    const project = this.db
      .prepare('SELECT path FROM projects WHERE id = ? AND archived_at IS NULL')
      .get(input.projectId) as { path: string } | undefined
    if (!project) throw new Error('Project not found')
    const workspace = await this.resolveWorkspace(
      input.projectId,
      project.path,
      input.workspace,
    )
    const session = this.create({
      projectId: input.projectId,
      harness: input.harness,
      accountId: input.accountId,
      ...workspace,
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
            'SELECT session_id FROM draft_promotions WHERE request_id = ?',
          )
          .get(requestId) as { session_id: string }
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
        input.model,
        input.clientItemId,
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
  async releaseHandle(id: string) {
    await this.handles.get(id)?.cancel()
    await this.handles.get(id)?.kill()
    this.forgetHandle(id)
    this.status(id, 'idle')
  }
  async discard(id: string, removeWorktree = false) {
    await this.handles.get(id)?.cancel()
    await this.handles.get(id)?.kill()
    if (removeWorktree) await this.removeSessionWorktree(id)
    this.forgetHandle(id)
    return Boolean(
      this.db
        .prepare(
          "UPDATE sessions SET retention = 'discardable', status = 'archived' WHERE id = ?",
        )
        .run(id).changes,
    )
  }

  async removeSessionWorktree(id: string) {
    const session = this.db
      .prepare(
        `SELECT sessions.*, projects.path AS project_path
         FROM sessions JOIN projects ON projects.id = sessions.project_id
         WHERE sessions.id = ?`,
      )
      .get(id) as
      | (SessionRow & {
          worktree_path?: string | null
          branch?: string | null
          project_path: string
        })
      | undefined
    if (!session) throw new WorktreeRemovalError('Session not found')
    if (!session.worktree_path) return false
    await this.releaseHandle(id)

    const activeSession = this.db
      .prepare(
        "SELECT 1 FROM sessions WHERE id != ? AND status != 'archived' AND (cwd = ? OR worktree_path = ?) LIMIT 1",
      )
      .get(id, session.worktree_path, session.worktree_path)
    if (activeSession)
      throw new WorktreeRemovalError('A session is using this worktree')

    const target = (await listWorktrees(session.project_path)).find(
      (worktree) => worktree.path === session.worktree_path,
    )
    if (!target)
      throw new WorktreeRemovalError('Session worktree is not registered')
    const status = await gitStatus(session.worktree_path)
    if (status.dirty)
      throw new WorktreeRemovalError('The worktree has uncommitted changes')
    await removeWorktree(session.project_path, session.worktree_path)
    const projectStatus = await gitStatus(session.project_path)
    await deleteMergedTemporaryBranch({
      repoPath: session.project_path,
      branch: target.branch ?? session.branch ?? '',
      defaultBranch: projectStatus.defaultBranch ?? projectStatus.branch,
      hasSessionReference: false,
    })
    return true
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

function parseConfigOptions(
  value: string | null | undefined,
): Record<string, string | boolean> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
