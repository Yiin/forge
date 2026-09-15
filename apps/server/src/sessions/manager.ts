import { NativeCleanupError } from '../harnesses/native-cleanup.js'
import {
  appendMessage,
  appendMessageInTransaction,
  publishAppendedMessage,
  createSession,
  getActiveSession,
  getSession,
} from '../db/queries.js'
import { readFile } from 'node:fs/promises'
import {
  acquireProjectActivity,
  withProjectActivity,
} from '../db/project-activity.js'
import { join } from 'node:path'
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
import type { QueuedPrompt } from '@forge/protocol/session'
import { rewriteSkillInvocation } from '../skills/registry.js'
import { TerminalError } from '../terminals/error.js'

type Db = DatabaseSync
type DraftPromotionInput = {
  draftId: string
  projectId?: string
  targetPath?: string
  harness: string
  text: string
  attachmentIds?: string[]
  accountId?: string | null
  model?: string
  clientItemId?: string
  workspace?: WorkspaceChoice
}
type PromotionOwner = {
  releaseProject?: () => void
  attempt?: Promise<{ sessionId: string }>
  rollback?: {
    draftId: string
    projectId?: string
    sessionId: string
    uploads?: UploadStore
    error: unknown
  }
}
export type SessionRow = {
  id: string
  project_id: string | null
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

export class PromptBusyError extends Error {
  readonly status = 409

  constructor() {
    super('Session is already running a turn')
    this.name = 'PromptBusyError'
  }
}

export class SessionManager {
  private readonly promotions = new Map<string, PromotionOwner>()
  private terminals?: import('../terminals/manager.js').TerminalManager
  setTerminalManager(
    manager: import('../terminals/manager.js').TerminalManager,
  ) {
    this.terminals = manager
  }
  private readonly handles = new Map<string, HarnessHandle>()
  private readonly generations = new Map<string, number>()
  private readonly availableModels = new Map<string, HarnessModel[]>()
  private readonly handleHarnesses = new Map<string, string>()
  private readonly reapTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly turnWaiters = new Map<
    string,
    { resolve: () => void; reject: (error: unknown) => void }
  >()
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
    projectId?: string | null
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
    targetPath?: string
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
    signal?: AbortSignal,
  ) {
    return withProjectActivity(this.db, projectId, async () => {
      const status = await gitStatus(projectPath, undefined, { signal })
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
        signal,
      })
      return {
        cwd: worktree.path,
        worktreePath: worktree.path,
        branch: worktree.branch,
      }
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
    const visible =
      "SELECT * FROM sessions WHERE deleted_at IS NULL AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL) AND retention = 'permanent'"
    if (parentSessionId) {
      const sql = projectId
        ? `${visible} AND project_id = ? AND parent_session_id = ? ORDER BY last_activity_at DESC`
        : `${visible} AND parent_session_id = ? ORDER BY last_activity_at DESC`
      return projectId
        ? this.db.prepare(sql).all(projectId, parentSessionId)
        : this.db.prepare(sql).all(parentSessionId)
    }
    const sql = projectId
      ? `${visible} AND project_id = ? ORDER BY last_activity_at DESC`
      : `${visible} ORDER BY last_activity_at DESC`
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

  private readonly pendingStarts = new Set<Promise<void>>()
  private assertOpen() {
    if (this.closeWork) throw new Error('Session manager is closed')
  }
  private startOwned<T>(start: () => Promise<T>): Promise<T> {
    this.assertOpen()
    const work = Promise.resolve().then(() => {
      this.assertOpen()
      return start()
    })
    const settled = work.then(
      () => undefined,
      (error) => {
        if (error instanceof NativeCleanupError) throw error
      },
    )
    this.pendingStarts.add(settled)
    void settled.then(
      () => this.pendingStarts.delete(settled),
      () => {
        // Retain failed cleanup and its original retry callback through close.
      },
    )
    return work
  }
  private async disposeHandle(handle: HarnessHandle): Promise<void> {
    try {
      await handle.kill()
    } catch {
      throw new NativeCleanupError(async () => {
        await handle.kill()
      })
    }
  }
  private async disposeLate(handle: HarnessHandle): Promise<never> {
    await this.disposeHandle(handle)
    throw new Error('Session manager is closed')
  }
  private spawn(row: SessionRow) {
    return this.startOwned(() => this.spawnOriginal(row))
  }
  private async spawnOriginal(row: SessionRow) {
    const generation = (this.generations.get(row.id) ?? 0) + 1
    this.generations.set(row.id, generation)
    const onItem = (item: HarnessItem) => {
      if (this.closeWork || this.generations.get(row.id) !== generation) return
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
        this.finishTurn(
          row,
          this.turns.get(row.id),
          normalized.type === 'turn_interrupted'
            ? new Error('Turn interrupted')
            : undefined,
        )
      }
    }
    const onExit = () => {
      if (this.closeWork || this.generations.get(row.id) !== generation) return
      const turnId = this.turns.get(row.id)
      this.forgetHandle(row.id)
      if (turnId) this.finishTurn(row, turnId, new Error('Harness exited'))
      if (
        this.db.prepare('SELECT status FROM sessions WHERE id = ?').get(row.id)
      )
        this.status(row.id, 'errored')
    }
    this.markAccountUsed(row.account_id)
    const process = this.factory(row.harness, row.account_id)
    this.assertOpen()
    const session = {
      id: row.id,
      cwd: row.cwd,
      harness: row.harness,
      accountId: row.account_id,
      providerSessionId: row.provider_session_id,
    }
    let handle: HarnessHandle
    if (row.provider_session_id) {
      if (!process.capabilities?.loadSession || !process.loadSession)
        throw new Error('Harness cannot resume the saved native session')
      const loaded = await process.loadSession(session, onItem, onExit)
      if (this.closeWork) return this.disposeLate(loaded.handle)
      if (!loaded.proven) {
        await this.disposeHandle(loaded.handle)
        throw new Error('Provider session load was not proven')
      }
      handle = loaded.handle
    } else {
      handle = await process.spawn(session, onItem, onExit)
    }
    if (this.closeWork) return this.disposeLate(handle)
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

  recover(row: SessionRow, recap?: string) {
    return this.startOwned(() => this.recoverOriginal(row, recap))
  }
  private async recoverOriginal(row: SessionRow, recap?: string) {
    const generation = (this.generations.get(row.id) ?? 0) + 1
    this.generations.set(row.id, generation)
    const process = this.factory(row.harness, row.account_id)
    this.assertOpen()
    const fallbackTurnId = makeId('turn_')
    const onItem = (item: HarnessItem) => {
      if (this.closeWork || this.generations.get(row.id) !== generation) return
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
      if (this.closeWork || this.generations.get(row.id) !== generation) return
      this.forgetHandle(row.id)
      this.status(row.id, 'errored')
    }
    const session = {
      id: row.id,
      cwd: row.cwd,
      harness: row.harness,
      accountId: row.account_id,
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
        if (this.closeWork) return this.disposeLate(result.handle)
        if (!result.proven) {
          await this.disposeHandle(result.handle)
          throw new Error('Provider session load was not proven')
        }
      } catch (error) {
        if (error instanceof NativeCleanupError) throw error
        // A failed native resume is not permission to create a replacement.
        // Keep the persisted binding and expose the provider failure instead.
        throw new Error(
          `Provider session resume failed: ${errorMessage(error)}`,
        )
      }
    } else {
      if (!process.newSession)
        throw new Error('Harness cannot create a session')
      result = await process.newSession(session, onItem, onExit)
      if (this.closeWork) return this.disposeLate(result.handle)
      if (!result.proven) {
        await this.disposeHandle(result.handle)
        throw new Error('New session was not proven')
      }
    }
    if (this.closeWork) return this.disposeLate(result.handle)
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
  private readonly queueBusy = new Set<string>()
  private readonly firstPrompt = new Map<string, string>()

  private finishTurn(
    row: SessionRow,
    turnId: string | undefined,
    error?: Error,
  ) {
    if (!turnId || this.turns.get(row.id) !== turnId) return
    this.turns.delete(row.id)
    const waiter = this.turnWaiters.get(`${row.id}:${turnId}`)
    if (waiter) {
      this.turnWaiters.delete(`${row.id}:${turnId}`)
      if (error) waiter.reject(error)
      else waiter.resolve()
    }
    if (this.closeWork) return
    if (!error) {
      this.status(row.id, 'idle')
      this.maybeTitle(row.id, row.title, this.firstPrompt.get(row.id) ?? '')
      this.scheduleReap(row.id)
      void this.drainQueue(row.id)
    } else this.status(row.id, 'errored')
  }

  private queuedPromptRows(sessionId: string) {
    return this.db
      .prepare(
        'SELECT * FROM queued_prompts WHERE session_id = ? ORDER BY order_index, created_at, id',
      )
      .all(sessionId) as Array<{
      id: string
      session_id: string
      text: string
      created_at: number
    }>
  }

  private queuedPrompt(row: {
    id: string
    session_id: string
    text: string
    created_at: number
    revision?: number
    order_index?: number
    attachment_ids?: string | null
    prompt_parts?: string | null
    review_references?: string | null
    model?: string | null
    config_options?: string | null
    delivery_state?: 'queued' | 'leased' | 'failed'
  }): QueuedPrompt {
    return {
      id: row.id,
      sessionId: row.session_id,
      text: row.text,
      createdAt: Number(row.created_at),
      revision: Number(row.revision ?? 0),
      order: Number(row.order_index ?? 0),
      attachmentIds: row.attachment_ids ? JSON.parse(row.attachment_ids) : [],
      promptParts: row.prompt_parts ? JSON.parse(row.prompt_parts) : [],
      reviewReferences: row.review_references
        ? JSON.parse(row.review_references)
        : [],
      model: row.model ?? null,
      configOptions: row.config_options ? JSON.parse(row.config_options) : null,
      deliveryState: row.delivery_state ?? 'queued',
    }
  }

  private publishQueuedPrompts(sessionId: string) {
    this.bus.publishEphemeral({
      type: 'queuedPrompts',
      seq: null,
      sessionId,
      prompts: this.queuedPromptRows(sessionId).map((row) =>
        this.queuedPrompt(row),
      ),
    })
  }

  queuedPrompts(sessionId: string) {
    if (!getSession(this.db, sessionId)) return undefined
    return this.queuedPromptRows(sessionId).map((row) => this.queuedPrompt(row))
  }

  deleteQueuedPrompt(sessionId: string, promptId: string) {
    const result = this.db
      .prepare('DELETE FROM queued_prompts WHERE id = ? AND session_id = ?')
      .run(promptId, sessionId) as { changes?: number }
    if (!result.changes) return false
    this.publishQueuedPrompts(sessionId)
    return true
  }

  updateQueuedPrompt(
    sessionId: string,
    promptId: string,
    text: string,
    revision?: number,
    attachmentIds?: string[],
  ) {
    const expected = revision ?? 0
    const result = this.db
      .prepare(
        `UPDATE queued_prompts
         SET text = ?, attachment_ids = COALESCE(?, attachment_ids),
             revision = revision + 1, delivery_state = 'queued', lease_id = NULL,
             lease_until = NULL
         WHERE id = ? AND session_id = ? AND revision = ?`,
      )
      .run(
        text,
        attachmentIds ? JSON.stringify(attachmentIds) : null,
        promptId,
        sessionId,
        expected,
      ) as { changes?: number }
    if (!result.changes) return undefined
    this.publishQueuedPrompts(sessionId)
    const row = this.db
      .prepare('SELECT * FROM queued_prompts WHERE id = ? AND session_id = ?')
      .get(promptId, sessionId) as Parameters<typeof this.queuedPrompt>[0]
    return this.queuedPrompt(row)
  }

  reorderQueuedPrompts(sessionId: string, promptIds: string[]) {
    const existing = this.queuedPromptRows(sessionId)
    if (
      existing.length !== promptIds.length ||
      new Set(promptIds).size !== promptIds.length
    )
      return undefined
    const known = new Set(existing.map((row) => row.id))
    if (promptIds.some((id) => !known.has(id))) return undefined
    const update = this.db.prepare(
      'UPDATE queued_prompts SET order_index = ? WHERE id = ? AND session_id = ?',
    )
    this.db.exec('BEGIN')
    try {
      promptIds.forEach((id, index) => update.run(index, id, sessionId))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.publishQueuedPrompts(sessionId)
    return this.queuedPrompts(sessionId)
  }

  async sendQueuedPromptNow(sessionId: string, promptId: string) {
    this.assertOpen()
    const row = this.db
      .prepare('SELECT * FROM queued_prompts WHERE id = ? AND session_id = ?')
      .get(promptId, sessionId) as
      | {
          text: string
          attachment_ids: string | null
          model: string | null
          config_options: string | null
          client_item_id: string | null
          prompt_parts: string | null
          review_references: string | null
          revision: number
        }
      | undefined
    if (!row) return false
    if (
      this.db
        .prepare(
          "SELECT 1 FROM messages WHERE session_id=? AND json_extract(content,'$.steeringRequestId')=?",
        )
        .get(sessionId, `queue_now_${promptId}_${row.revision}`)
    )
      throw new Error(
        'Native steering was already admitted; delivery cannot be repeated',
      )
    const activeTurn = this.turns.get(sessionId)
    // Interrupting a turn whose harness is still spawning is a no-op, so the
    // wait below would run for the whole turn. Refuse instead of hanging.
    if (activeTurn && !this.handles.get(sessionId))
      throw new Error('Session is still starting')
    const leaseId = makeId('lease_')
    const claimed = this.db
      .prepare(
        `UPDATE queued_prompts SET delivery_state = 'leased', lease_id = ?,
         lease_until = ? WHERE id = ? AND session_id = ? AND revision = ? AND
         (delivery_state <> 'leased' OR lease_until IS NULL OR lease_until < ?)`,
      )
      .run(
        leaseId,
        Date.now() + 60_000,
        promptId,
        sessionId,
        row.revision,
        Date.now(),
      ) as { changes?: number }
    if (!claimed.changes)
      throw new Error('Queued prompt is already being delivered')
    this.publishQueuedPrompts(sessionId)
    // Hold the drain lock so the interrupted turn does not deliver the queue
    // head while this prompt takes its place.
    this.queueBusy.add(sessionId)
    try {
      const steer = Boolean(activeTurn && this.handles.get(sessionId)?.steer)
      const stopped =
        activeTurn && !steer
          ? new Promise<void>((resolve) => {
              // Chain any waiter already registered for this turn. Replacing it
              // would strand a caller that awaits turn completion.
              const key = `${sessionId}:${activeTurn}`
              const waiting = this.turnWaiters.get(key)
              this.turnWaiters.set(key, {
                resolve: () => {
                  waiting?.resolve()
                  resolve()
                },
                reject: (error) => {
                  waiting?.reject(error)
                  resolve()
                },
              })
            })
          : undefined
      if (!steer) await this.interrupt(sessionId)
      if (stopped) await stopped
      // The wait is unbounded, so the lease may have expired and been taken
      // over by a second send now. Re-assert it before delivering.
      const held = this.db
        .prepare(
          'UPDATE queued_prompts SET lease_until = ? WHERE id = ? AND lease_id = ?',
        )
        .run(Date.now() + 60_000, promptId, leaseId) as { changes?: number }
      if (!held.changes) throw new Error('Queued prompt was taken over')
      await this.prompt(
        sessionId,
        row.text,
        `queue_now_${promptId}_${row.revision}`,
        row.attachment_ids ? JSON.parse(row.attachment_ids) : undefined,
        undefined,
        undefined,
        row.model ?? undefined,
        row.client_item_id ?? undefined,
        row.config_options ? JSON.parse(row.config_options) : undefined,
        'immediate',
        false,
        row.review_references ? JSON.parse(row.review_references) : undefined,
        row.prompt_parts ? JSON.parse(row.prompt_parts) : undefined,
        row.revision,
      )
      // Delete only after delivery, as drainQueue does, so a failed prompt
      // stays recoverable instead of vanishing.
      const deleted = this.db
        .prepare('DELETE FROM queued_prompts WHERE id = ? AND lease_id = ?')
        .run(promptId, leaseId) as { changes?: number }
      if (deleted.changes) this.publishQueuedPrompts(sessionId)
      return true
    } catch (error) {
      const released = this.db
        .prepare(
          `UPDATE queued_prompts SET delivery_state = 'failed', lease_id = NULL,
           lease_until = NULL WHERE id = ? AND lease_id = ?`,
        )
        .run(promptId, leaseId) as { changes?: number }
      if (released.changes) this.publishQueuedPrompts(sessionId)
      throw error
    } finally {
      this.queueBusy.delete(sessionId)
    }
  }

  async drainQueuedPrompt(sessionId: string) {
    return this.drainQueue(sessionId)
  }

  private async drainQueue(sessionId: string) {
    if (this.closeWork) return
    if (this.queueBusy.has(sessionId) || this.turns.has(sessionId)) return
    const queued = this.db
      .prepare(
        `SELECT * FROM queued_prompts
         WHERE session_id = ? AND (delivery_state = 'queued' OR
           (delivery_state = 'leased' AND (lease_until IS NULL OR lease_until < ?)))
         ORDER BY order_index, created_at, id LIMIT 1`,
      )
      .get(sessionId, Date.now()) as
      | {
          id: string
          text: string
          attachment_ids: string | null
          model: string | null
          config_options: string | null
          client_item_id: string | null
          prompt_parts: string | null
          review_references: string | null
          revision: number
          order_index: number
          delivery_state: 'queued' | 'leased' | 'failed'
        }
      | undefined
    if (!queued) return
    this.queueBusy.add(sessionId)
    const leaseId = makeId('lease_')
    try {
      const leased = this.db
        .prepare(
          `UPDATE queued_prompts SET delivery_state = 'leased', lease_id = ?,
           lease_until = ? WHERE id = ? AND revision = ? AND
           (delivery_state = 'queued' OR (delivery_state = 'leased' AND lease_until < ?))`,
        )
        .run(
          leaseId,
          Date.now() + 30_000,
          queued.id,
          queued.revision,
          Date.now(),
        ) as {
        changes?: number
      }
      if (!leased.changes) return
      this.publishQueuedPrompts(sessionId)
      await this.prompt(
        sessionId,
        queued.text,
        makeId('queue_'),
        queued.attachment_ids ? JSON.parse(queued.attachment_ids) : undefined,
        undefined,
        undefined,
        queued.model ?? undefined,
        queued.client_item_id ?? undefined,
        queued.config_options ? JSON.parse(queued.config_options) : undefined,
        'immediate',
        false,
        queued.review_references
          ? JSON.parse(queued.review_references)
          : undefined,
        queued.prompt_parts ? JSON.parse(queued.prompt_parts) : undefined,
        queued.revision,
      )
      this.db
        .prepare('DELETE FROM queued_prompts WHERE id = ? AND lease_id = ?')
        .run(queued.id, leaseId)
    } catch (error) {
      this.db
        .prepare(
          `UPDATE queued_prompts SET delivery_state = 'failed', lease_id = NULL,
           lease_until = NULL WHERE id = ? AND lease_id = ?`,
        )
        .run(queued.id, leaseId)
      throw error
    } finally {
      this.queueBusy.delete(sessionId)
    }
  }
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
    if (this.closeWork) return
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
    configOptions?: Record<string, string | boolean>,
    delivery?: 'immediate' | 'turn-boundary',
    reviewReferences?: unknown[],
    promptParts?: unknown[],
    revision?: number,
  ) {
    const owner = getActiveSession(this.db, id) as SessionRow | undefined
    if (!owner) throw new Error('Session not found')
    const run = async () => {
      let row = owner
      if (requestId) {
        const seen = this.db
          .prepare(
            `SELECT 1 FROM messages
           WHERE session_id = ? AND type = 'turn_start'
             AND json_extract(content, '$.requestId') = ?
           UNION ALL
           SELECT 1 FROM queued_prompts
           WHERE session_id = ? AND request_id = ?`,
          )
          .get(id, requestId, id, requestId)
        if (seen) return
      }
      if ((delivery ?? 'immediate') === 'immediate' && this.turns.has(id))
        throw new PromptBusyError()
      if (delivery === 'turn-boundary' && this.turns.has(id)) {
        this.db
          .prepare(
            `INSERT INTO queued_prompts
           (id, session_id, text, attachment_ids, model, config_options, client_item_id,
            request_id, prompt_parts, review_references, revision, order_index, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            makeId('queued_'),
            id,
            text,
            attachmentIds ? JSON.stringify(attachmentIds) : null,
            model ?? null,
            configOptions ? JSON.stringify(configOptions) : null,
            clientItemId ?? null,
            requestId ?? null,
            promptParts ? JSON.stringify(promptParts) : null,
            reviewReferences ? JSON.stringify(reviewReferences) : null,
            revision ?? 0,
            Number(
              (
                this.db
                  .prepare(
                    'SELECT COALESCE(MAX(order_index), -1) + 1 AS next_order FROM queued_prompts WHERE session_id = ?',
                  )
                  .get(id) as { next_order: number }
              ).next_order,
            ),
            Date.now(),
          )
        this.publishQueuedPrompts(id)
        return
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
        if (!getActiveSession(this.db, id)) throw new Error('Session not found')
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
      const attachments: import('./harness.js').PromptContent[] = []
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
        if (attachment?.rel_path) {
          const absolutePath = join(this.dataDir, attachment.rel_path)
          if (attachment.mime.startsWith('image/'))
            attachments.push({
              kind: 'image',
              attachmentId: attachment.id,
              mime: attachment.mime,
              bytes: await readFile(absolutePath),
              path: absolutePath,
            })
          else
            attachments.push({
              kind: 'file',
              attachmentId: attachment.id,
              path: absolutePath,
              name: attachment.filename,
              mime: attachment.mime,
            })
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
      }
      if (text)
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
      return { row, turnId, model, attachments }
    }
    return owner.project_id
      ? withProjectActivity(this.db, owner.project_id, run)
      : run()
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
    delivery?: 'immediate' | 'turn-boundary',
    waitForCompletion = false,
    reviewReferences?: unknown[],
    promptParts?: unknown[],
    revision?: number,
  ) {
    this.assertOpen()
    if (delivery === 'immediate' && this.turns.has(id)) {
      const handle = this.handles.get(id)
      if (handle?.steer) {
        if (promptParts?.length)
          throw new Error('Native steering does not support these prompt parts')
        if (!text && !attachmentIds?.length)
          throw new Error('Native steering requires text or attachments')
        const owner = getActiveSession(this.db, id) as SessionRow | undefined
        if (!owner) throw new Error('Session not found')
        if (
          (harness && harness !== owner.harness) ||
          (accountId !== undefined && accountId !== owner.account_id)
        )
          throw new Error('Cannot change harness during a turn')
        const turnId = this.turns.get(id)!
        const itemId = clientItemId ?? makeId('item_')
        const admissionId = requestId ?? itemId
        if (
          this.db
            .prepare(
              "SELECT 1 FROM messages WHERE session_id=? AND (item_id=? OR (json_extract(content,'$.steeringRequestId')=?))",
            )
            .get(id, itemId, admissionId)
        )
          throw new Error(
            'Native steering was already admitted; delivery cannot be repeated',
          )
        const content: import('./harness.js').PromptContent[] = []
        const references: Array<{
          attachmentId: string
          filename: string
          mime: string
          sizeBytes: number
          path: string
        }> = []
        for (const attachmentId of attachmentIds ?? []) {
          const attachment = this.db
            .prepare(
              "SELECT filename, mime, size_bytes, rel_path FROM attachments WHERE id=? AND session_id=? AND status='complete'",
            )
            .get(attachmentId, id) as
            | {
                filename: string
                mime: string
                size_bytes: number
                rel_path: string | null
              }
            | undefined
          if (!attachment?.rel_path)
            throw new Error('Attachment is not available')
          content.push({
            kind: 'file',
            attachmentId,
            name: attachment.filename,
            mime: attachment.mime,
            path: join(this.dataDir, attachment.rel_path),
          })
          references.push({
            attachmentId,
            filename: attachment.filename,
            mime: attachment.mime,
            sizeBytes: attachment.size_bytes,
            path: attachment.rel_path,
          })
        }
        if (text) content.push({ kind: 'text', text })
        const saved = []
        this.db.exec('BEGIN')
        try {
          saved.push(
            appendMessageInTransaction(this.db, {
              sessionId: id,
              turnId,
              itemId,
              role: 'user',
              type: 'text_delta',
              content: {
                type: 'text_delta',
                text,
                steeringRequestId: admissionId,
              } as never,
            }),
          )
          for (const reference of references)
            saved.push(
              appendMessageInTransaction(this.db, {
                sessionId: id,
                turnId,
                itemId: makeId('item_'),
                role: 'user',
                type: 'attachment_ref',
                content: { type: 'attachment_ref', ...reference },
              }),
            )
          this.db.exec('COMMIT')
        } catch (error) {
          this.db.exec('ROLLBACK')
          throw error
        }
        for (const message of saved) publishAppendedMessage(this.bus, message)
        await handle.steer(
          content.length === 1 && content[0]!.kind === 'text' ? text : content,
        )
        return
      }
    }
    const accepted = await this.acceptPrompt(
      id,
      text,
      requestId,
      attachmentIds,
      harness,
      accountId,
      model,
      clientItemId,
      configOptions,
      delivery,
      reviewReferences,
      promptParts,
      revision,
    )
    if (!accepted) return
    const completion = waitForCompletion
      ? new Promise<void>((resolve, reject) => {
          this.turnWaiters.set(`${accepted.row.id}:${accepted.turnId}`, {
            resolve,
            reject,
          })
        })
      : undefined
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
      const dispatchText = /^\$[a-z0-9][a-z0-9-]*(?=\s|$)/.test(text)
        ? await rewriteSkillInvocation(row.cwd, text)
        : text
      const content = [...accepted.attachments]
      if (dispatchText) content.push({ kind: 'text', text: dispatchText })
      this.runPrompt(handle, row, accepted.turnId, content)
    })().catch((error: unknown) =>
      this.failPrompt(accepted.row, accepted.turnId, error),
    )
    if (completion) return completion
  }

  private runPrompt(
    handle: HarnessHandle,
    row: SessionRow,
    turnId: string,
    content: import('./harness.js').PromptContent[],
  ) {
    try {
      this.assertOpen()
      const result = handle.prompt(content)
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
    if (this.turns.get(row.id) !== turnId) return
    if (this.closeWork) {
      this.finishTurn(
        row,
        turnId,
        new Error('Session interrupted by server shutdown'),
      )
      return
    }
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
    const waiter = this.turnWaiters.get(`${row.id}:${turnId}`)
    if (waiter) {
      this.turnWaiters.delete(`${row.id}:${turnId}`)
      waiter.reject(error)
    }
    this.turns.delete(row.id)
    void this.drainQueue(row.id)
  }

  private finishPrompt(row: SessionRow, turnId: string) {
    if (this.closeWork) {
      this.finishTurn(
        row,
        turnId,
        new Error('Session interrupted by server shutdown'),
      )
      return
    }
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
      this.finishTurn(row, turnId)
    }
  }

  async promoteDraft(
    input: DraftPromotionInput,
    requestId: string,
    uploads?: UploadStore,
  ) {
    this.assertOpen()
    const retained = this.promotions.get(requestId)
    const run = async () => {
      if (retained)
        return (
          retained.attempt ??
          this.runPromotionAttempt(requestId, retained, () =>
            this.rollbackDraftPromotion(retained),
          )
        )
      // Idempotency keys on the promotion attempt (requestId), never on the
      // draft id: drafts are reused across sessions, so a draft-scoped lookup
      // would return a previous session and silently drop the new prompt.
      const existing = this.db
        .prepare('SELECT session_id FROM draft_promotions WHERE request_id = ?')
        .get(requestId) as { session_id: string } | undefined
      if (existing) {
        if (!getActiveSession(this.db, existing.session_id))
          throw new Error('Session not found')
        return { sessionId: existing.session_id }
      }
      if (this.promotions.size >= (this.terminals?.limits.http ?? 32))
        throw new TerminalError(
          'capacity',
          429,
          'Draft promotion capacity reached',
        )
      const owner: PromotionOwner = {
        releaseProject: input.projectId
          ? acquireProjectActivity(this.db, input.projectId)
          : undefined,
      }
      this.promotions.set(requestId, owner)
      return this.runPromotionAttempt(requestId, owner, () =>
        this.promoteDraftAttempt(input, requestId, uploads, owner),
      )
    }
    const projectId = retained?.rollback?.projectId ?? input.projectId
    return projectId ? withProjectActivity(this.db, projectId, run) : run()
  }

  private runPromotionAttempt(
    requestId: string,
    owner: PromotionOwner,
    operation: () => Promise<{ sessionId: string }>,
  ) {
    const attempt = Promise.resolve().then(operation)
    owner.attempt = attempt
    void attempt
      .finally(() => {
        if (owner.attempt !== attempt) return
        owner.attempt = undefined
        if (!owner.rollback) {
          owner.releaseProject?.()
          this.promotions.delete(requestId)
        }
      })
      .catch(() => {})
    return attempt
  }

  private async promoteDraftAttempt(
    input: DraftPromotionInput,
    requestId: string,
    uploads: UploadStore | undefined,
    owner: PromotionOwner,
  ) {
    const project = input.projectId
      ? (this.db
          .prepare(
            'SELECT path FROM projects WHERE id = ? AND archived_at IS NULL AND deleted_at IS NULL',
          )
          .get(input.projectId) as { path: string } | undefined)
      : undefined
    if (input.projectId && !project) throw new Error('Project not found')
    if (!input.projectId && !input.targetPath)
      throw new Error('A filesystem target is required')
    const workspace = input.projectId
      ? await this.resolveWorkspace(
          input.projectId,
          project!.path,
          input.workspace,
        )
      : { cwd: input.targetPath!, worktreePath: null, branch: null }
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
      owner.rollback = {
        draftId: input.draftId,
        projectId: input.projectId,
        sessionId: session.id,
        uploads,
        error,
      }
      return this.rollbackDraftPromotion(owner)
    }
  }

  private async rollbackDraftPromotion(owner: PromotionOwner): Promise<never> {
    const { draftId, projectId, sessionId, uploads, error } = owner.rollback!
    const rollback = async () => {
      if (uploads)
        await uploads.rollbackPromotion(draftId, sessionId, projectId)
      this.db
        .prepare('DELETE FROM draft_promotions WHERE session_id = ?')
        .run(sessionId)
      await this.discard(sessionId)
      this.db
        .prepare('DELETE FROM messages WHERE session_id = ?')
        .run(sessionId)
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
    }
    try {
      if (this.terminals)
        await this.terminals.removeSession(sessionId, rollback)
      else await rollback()
    } catch (cleanup) {
      const failure = new TerminalError(
        'rollback_cleanup_unknown',
        503,
        'Promotion rollback did not complete',
        { sessionId },
      )
      failure.cause = new AggregateError(
        [error, cleanup],
        'Promotion failed and rollback did not complete',
      )
      throw failure
    }
    owner.rollback = undefined
    throw error
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
    const operation = () => this.removeSessionWorktreeData(id)
    const row = this.db
      .prepare('SELECT worktree_path FROM sessions WHERE id=?')
      .get(id) as { worktree_path: string | null } | undefined
    if (!row) throw new WorktreeRemovalError('Session not found')
    if (!row.worktree_path) return false
    return this.terminals
      ? this.terminals.removeWorkspace(id, operation)
      : operation()
  }

  private async removeSessionWorktreeData(id: string) {
    const session = this.db
      .prepare(
        `SELECT sessions.*, projects.path AS project_path
         FROM sessions JOIN projects ON projects.id = sessions.project_id AND projects.deleted_at IS NULL
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
  async answer(id: string, questionId: string, answer: unknown) {
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
  private closeWork?: Promise<void>
  close(): Promise<void> {
    if (this.closeWork) return this.closeWork
    for (const timer of this.reapTimers.values()) clearTimeout(timer)
    const original = [...this.handles.values()]
    this.closeWork = Promise.resolve().then(async () => {
      const settled = await Promise.allSettled([
        ...original.map((handle) =>
          Promise.resolve().then(() => handle.kill()),
        ),
        ...[...this.pendingStarts].map(async (start) => {
          try {
            await start
          } catch (error) {
            if (!(error instanceof NativeCleanupError)) throw error
            await error.retryCleanup()
            this.pendingStarts.delete(start)
          }
        }),
      ])
      const failures = settled.filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      )
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          'Session cleanup failed',
        )
    })
    return this.closeWork
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
