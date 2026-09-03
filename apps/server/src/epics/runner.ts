import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { EventBus } from '../events/bus.js'
import { errorMessage } from '../error-message.js'
import {
  claim,
  hasCommentSince,
  openChildren,
  releaseClaim,
  readyChildren,
  show,
} from './beads.js'
import { acquireRunLock } from './worktrees.js'
import {
  createWorktree,
  listRunWorktrees,
  mergeBranch,
  removeWorktree,
  trialMerge,
  type ConflictReport,
} from './worktrees.js'
import {
  createIteration,
  createRun,
  createSession,
  settleIteration,
  updateRunStatus,
  updateRunConfig,
} from '../db/queries.js'
import {
  blockedAccounts,
  detectProviderError,
  recordLimit,
  type LimitCategory,
} from '../accounts/limits.js'
import {
  appendTriageCard,
  classifyGate,
  failureSignature,
  isDependencyFailure,
  readSignatures,
  rememberSignature,
  retryFlakyGate,
  runGate,
  triageCard,
  type FailureEntry,
} from './triage.js'
import { workerPrompt } from './prompts.js'
const exec = promisify(execFile)
type Db = {
  exec(sql: string): unknown
  prepare(sql: string): {
    run(...args: unknown[]): unknown
    get(...args: unknown[]): any
    all(...args: unknown[]): any[]
  }
}
export type WorkerSession = {
  id: string
  prompt(text: string, delivery?: 'immediate' | 'turn-boundary'): Promise<void>
  cancel(): Promise<void>
}
export type SessionManager = {
  create(input: EpicSessionInput): Promise<WorkerSession>
}
export type EpicSessionInput = {
  projectId: string
  harness: string
  cwd: string
  title: string
  kind: 'epic_worker'
  epicRunId: string
  accountId?: string | null
}
export type StartRunInput = {
  projectId: string
  epicBeadId: string
  repoPath: string
  baseBranch: string
  mode: 'serial' | 'pool' | 'auto'
  workerCount: number
  config: unknown
  originSessionId?: string | null
}
async function git(repo: string, args: string[]) {
  return (await exec('git', args, { cwd: repo })).stdout.trim()
}
type IterationResult = {
  id: string
  branch: string
  beadId: string
  worktreePath: string
}
export type ProviderHop = { harness: string; model?: string }
export type AttemptAccount = {
  id: string
  harnessKey: string
  orderIndex: number
  disabledAt?: number | null
}
export type PlannedAttempt = ProviderHop & { accountId?: string }

export function planAttempts(
  hops: readonly ProviderHop[],
  accounts: readonly AttemptAccount[],
  blocked: ReadonlySet<string>,
  requiresAccount: (harness: string) => boolean = () => true,
): PlannedAttempt[] {
  return hops.flatMap((hop) => {
    const candidates = accounts
      .filter(
        (account) =>
          account.harnessKey === hop.harness &&
          !account.disabledAt &&
          !blocked.has(account.id),
      )
      .sort((a, b) => a.orderIndex - b.orderIndex)
    if (candidates.length)
      return candidates.map((account) => ({ ...hop, accountId: account.id }))
    // A harness with no managed-account kind runs on ambient credentials.
    if (!requiresAccount(hop.harness)) return [{ ...hop }]
    return []
  })
}

export type PromptFailureDecision = {
  category: LimitCategory | null
  recordCooldown: boolean
  detectedAt: number
}

export function classifyPromptFailure(
  error: unknown,
  now: number,
): PromptFailureDecision {
  const match = detectProviderError(errorMessage(error))
  return {
    category: match?.category ?? null,
    recordCooldown:
      match?.category === 'usage-limit' ||
      match?.category === 'spend-limit' ||
      match?.category === 'rate-limit',
    detectedAt: now,
  }
}

function providerHops(config: unknown): ProviderHop[] {
  const value = config as {
    rolePolicy?: {
      roles?: Record<string, string>
      tiers?: Record<string, Array<{ harness: string; model?: string }>>
    }
  }
  const tier = value.rolePolicy?.roles?.['iteration-worker']
  const hops = tier ? value.rolePolicy?.tiers?.[tier] : undefined
  return hops?.length ? hops : [{ harness: 'default' }]
}
type DispatchResult =
  | { kind: 'ready'; item: IterationResult }
  | { kind: 'failed'; beadId: string; reason: string }
  | { kind: 'cancelled'; beadId: string }

const ACCOUNT_LIMIT_TTL_MS = 24 * 60 * 60 * 1000

type PromptAttemptsInput = {
  run: any
  input: StartRunInput
  bead: any
  cwd: string
  branch: string
  signal: AbortSignal
  setActive?: (session: WorkerSession) => void
  setWorker?: (iterationId: string, session: WorkerSession) => void
  clearWorker?: (iterationId: string) => void
  requiresAccount?: (harness: string) => boolean
}

type PromptAttemptsResult = {
  session?: WorkerSession
  iteration?: ReturnType<typeof createIteration>
  promptError?: unknown
}

async function runPromptAttempts(
  db: Db,
  sessions: SessionManager,
  value: PromptAttemptsInput,
): Promise<PromptAttemptsResult> {
  const hops = providerHops(value.input.config)
  let lastIteration: ReturnType<typeof createIteration> | undefined
  let lastSession: WorkerSession | undefined
  let promptError: unknown
  const attemptedKeys = new Set<string>()
  const exhaustedHarnesses = new Set<string>()
  let attemptNumber = 0
  while (!value.signal.aborted) {
    const rows = db
      .prepare(
        'SELECT id, harness_key AS harnessKey, order_index AS orderIndex, disabled_at AS disabledAt FROM harness_accounts WHERE disabled_at IS NULL ORDER BY order_index, created_at',
      )
      .all() as AttemptAccount[]
    const attempts = planAttempts(
      hops,
      rows,
      blockedAccounts(db, Date.now(), ACCOUNT_LIMIT_TTL_MS),
      value.requiresAccount ?? (() => true),
    )
    const next = attempts.find((candidate) => {
      const key = `${candidate.harness}\0${candidate.model ?? ''}\0${candidate.accountId ?? ''}`
      return (
        !exhaustedHarnesses.has(candidate.harness) && !attemptedKeys.has(key)
      )
    })
    if (!next) {
      if (!lastIteration)
        promptError = new Error('No available fallback account')
      break
    }
    const nextKey = `${next.harness}\0${next.model ?? ''}\0${next.accountId ?? ''}`
    attemptedKeys.add(nextKey)
    attemptNumber += 1
    const session = await sessions.create({
      projectId: value.input.projectId,
      harness: next.harness,
      accountId: next.accountId ?? null,
      cwd: value.cwd,
      title: value.bead.title,
      kind: 'epic_worker',
      epicRunId: value.run.id,
    })
    lastSession = session
    value.setActive?.(session)
    const iteration = createIteration(db, {
      runId: value.run.id,
      beadId: value.bead.id,
      sessionId: session.id,
      worktreePath: value.cwd,
      branch: value.branch,
      attempt: attemptNumber,
      harness: next.harness,
      model: next.model ?? null,
      accountId: next.accountId ?? null,
    })
    lastIteration = iteration
    value.setWorker?.(iteration.id, session)
    try {
      await session.prompt(
        workerPrompt(
          await show(value.input.repoPath, value.bead.id),
          value.cwd,
          value.branch,
        ),
      )
      return { session, iteration }
    } catch (error) {
      promptError = error
      const detectedAt = Date.now()
      const decision = classifyPromptFailure(error, detectedAt)
      if (!decision.recordCooldown) exhaustedHarnesses.add(next.harness)
      if (decision.recordCooldown && next.accountId) {
        const match = detectProviderError(errorMessage(error))
        recordLimit(db, {
          accountId: next.accountId,
          kind: decision.category!,
          harnessKey: next.harness,
          detectedAt: decision.detectedAt,
          source: 'epic.runner',
          detail: match?.excerpt,
        })
      }
      settleIteration(
        db,
        iteration.id,
        'failed',
        `Fallback attempt ${attemptNumber} (${next.harness}${next.accountId ? `/${next.accountId}` : ''}) failed: ${errorMessage(error)}`,
      )
      await session.cancel().catch(() => undefined)
    } finally {
      value.clearWorker?.(lastIteration.id)
    }
  }
  return { session: lastSession, iteration: lastIteration, promptError }
}
export class EpicRunner {
  private active = new Map<
    string,
    { abort: AbortController; session?: WorkerSession }
  >()
  private inputs = new Map<string, StartRunInput>()
  private workerSessions = new Map<string, WorkerSession>()
  private skippedBeads = new Map<string, Set<string>>()
  constructor(
    private readonly db: Db,
    private readonly sessions: SessionManager,
    private readonly bus = new EventBus(),
    private readonly requiresAccount: (harness: string) => boolean = () => true,
  ) {}
  get eventBus() {
    return this.bus
  }
  private async cleanupRunWorktrees(runId: string, repoPath: string) {
    for (const worktree of await listRunWorktrees(repoPath, runId))
      await removeWorktree(repoPath, worktree, false).catch(() => undefined)
  }
  async startRun(input: StartRunInput) {
    const run = createRun(this.db, {
      projectId: input.projectId,
      epicBeadId: input.epicBeadId,
      status: 'running',
      mode: input.mode === 'auto' ? 'serial' : input.mode,
      workerCount: input.workerCount,
      baseBranch: input.baseBranch,
      config: input.config,
      originSessionId: input.originSessionId ?? null,
    })
    this.inputs.set(run.id, input)
    const abort = new AbortController()
    this.active.set(run.id, { abort })
    void this.loop(run, input, abort.signal).catch(
      (error) => void this.fail(run.id, errorMessage(error)),
    )
    return run
  }
  private async loop(run: any, input: StartRunInput, signal: AbortSignal) {
    const lock = await acquireRunLock(input.repoPath, input.epicBeadId, {
      runId: run.id,
    })
    try {
      if (input.mode === 'pool' || input.mode === 'auto') {
        await this.poolLoop(run, input, signal)
        return
      }
      while (!signal.aborted) {
        const children = (
          await readyChildren(input.repoPath, input.epicBeadId)
        ).filter((child) => !this.skippedBeads.get(run.id)?.has(child.id))
        if (!children.length) {
          if (!(await openChildren(input.repoPath, input.epicBeadId)).length) {
            updateRunStatus(this.db, run.id, 'completed')
            await this.cleanupRunWorktrees(run.id, input.repoPath)
            this.publish(run.id, 'completed')
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 250))
          continue
        }
        const bead = [...children].sort((a, b) => a.priority - b.priority)[0]!
        const dispatchedAt = new Date().toISOString()
        const before = await git(input.repoPath, [
          'rev-parse',
          input.baseBranch,
        ])
        await claim(input.repoPath, bead.id)
        const attempts = await runPromptAttempts(this.db, this.sessions, {
          requiresAccount: this.requiresAccount,
          run,
          input,
          bead,
          cwd: input.repoPath,
          branch: input.baseBranch,
          signal,
          setActive: (session) => {
            this.active.get(run.id)!.session = session
          },
        })
        const iteration = attempts.iteration
        const promptError = attempts.promptError
        if (promptError) {
          if (signal.aborted) {
            if (iteration)
              settleIteration(
                this.db,
                iteration.id,
                'interrupted',
                'Run cancelled',
              )
            await releaseClaim(input.repoPath, bead.id)
            return
          }
          await this.fail(run.id, String(promptError))
          return
        }
        const closed = (await show(input.repoPath, bead.id)).status === 'closed'
        if (signal.aborted) {
          settleIteration(
            this.db,
            iteration!.id,
            'interrupted',
            'Run cancelled',
          )
          if (!closed) await releaseClaim(input.repoPath, bead.id)
          return
        }
        const commits = Number(
          await git(input.repoPath, [
            'rev-list',
            '--count',
            `${before}..${input.baseBranch}`,
          ]),
        )
        const evidence =
          commits > 0 ||
          (await hasCommentSince(input.repoPath, bead.id, dispatchedAt))
        if (!closed || !evidence) {
          settleIteration(
            this.db,
            iteration!.id,
            'failed',
            'Child closed without a commit or comment evidence',
          )
          await this.fail(run.id, 'Child effects proof failed')
          return
        }
        settleIteration(this.db, iteration!.id, 'merged')
      }
      updateRunStatus(this.db, run.id, 'paused')
      this.publish(run.id, 'paused')
    } finally {
      await lock.release()
      this.active.delete(run.id)
    }
  }
  private async poolLoop(run: any, input: StartRunInput, signal: AbortSignal) {
    const max = Math.max(1, input.workerCount || 3)
    const inFlight = new Map<string, Promise<DispatchResult>>()
    const queue: DispatchResult[] = []
    const lastHeads = new Map<string, string>()
    const radar = setInterval(
      () => void this.probeRadar(run.id, input, lastHeads),
      180_000,
    )
    try {
      while (!signal.aborted) {
        const ready = (await readyChildren(input.repoPath, input.epicBeadId))
          .filter((child) => !this.skippedBeads.get(run.id)?.has(child.id))
          .sort((a, b) => a.priority - b.priority)
        const pooled =
          input.mode === 'pool' || ready.length > 1 || inFlight.size > 1
        while (inFlight.size < (pooled ? max : 1) && ready.length) {
          const bead = ready.shift()!
          const task = this.dispatch(run, input, bead, signal).catch(
            (error) => ({
              kind: 'failed' as const,
              beadId: bead.id,
              reason: errorMessage(error),
            }),
          )
          inFlight.set(bead.id, task)
          task.then((dispatchResult) => {
            queue.push(dispatchResult)
          })
        }
        while (queue.length) {
          const dispatchResult = queue.shift()!
          if (dispatchResult.kind !== 'ready') {
            await this.handleDispatchFailure(run, input, dispatchResult)
            return
          }
          const item = dispatchResult.item
          const config = input.config as {
            gateCommand?: string | string[]
            installCommand?: string | string[]
          }
          if (config?.gateCommand) {
            let branchGate = await runGate(
              item.worktreePath,
              config.gateCommand,
            )
            if (branchGate.code !== 0) {
              const control = await runGate(input.repoPath, config.gateCommand)
              const retry = await retryFlakyGate(branchGate, control, () =>
                runGate(item.worktreePath, config.gateCommand!),
              )
              if (retry?.code !== 0) {
                if (retry) branchGate = retry
                const classification = classifyGate(branchGate, control)
                const handled = await this.handleFailure(
                  run,
                  input,
                  item,
                  branchGate.output,
                  classification,
                  config,
                )
                if (handled) {
                  if (
                    this.db
                      .prepare('SELECT status FROM epic_runs WHERE id = ?')
                      .get(run.id)?.status === 'paused'
                  )
                    return
                  continue
                }
              }
            }
          }
          const mergeResult = await mergeBranch(
            input.repoPath,
            input.baseBranch,
            item.branch,
            undefined,
          )
          if (mergeResult !== 'clean') {
            const output = JSON.stringify(mergeResult)
            const control = config?.gateCommand
              ? await runGate(input.repoPath, config.gateCommand)
              : { code: 1, output }
            const classification = classifyGate({ code: 1, output }, control)
            await this.handleFailure(
              run,
              input,
              item,
              output,
              classification,
              config,
            )
            if (
              this.db
                .prepare('SELECT status FROM epic_runs WHERE id = ?')
                .get(run.id)?.status === 'paused'
            )
              return
            continue
          }
          settleIteration(this.db, item.id, 'merged')
          await removeWorktree(input.repoPath, item.worktreePath, false)
        }
        if (inFlight.size) {
          const settled = await Promise.race(
            [...inFlight.entries()].map(
              async ([id, task]) => [id, await task] as const,
            ),
          )
          inFlight.delete(settled[0])
          continue
        }
        const runStatus = this.db
          .prepare('SELECT status FROM epic_runs WHERE id = ?')
          .get(run.id)?.status
        if (runStatus === 'paused' || runStatus === 'cancelled') return
        if (!(await openChildren(input.repoPath, input.epicBeadId)).length) {
          updateRunStatus(this.db, run.id, 'completed')
          await this.cleanupRunWorktrees(run.id, input.repoPath)
          this.publish(run.id, 'completed')
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      updateRunStatus(this.db, run.id, 'paused')
      this.publish(run.id, 'paused')
    } finally {
      clearInterval(radar)
    }
  }
  private async handleDispatchFailure(
    run: any,
    input: StartRunInput,
    result: Exclude<DispatchResult, { kind: 'ready' }>,
  ) {
    if (result.kind === 'cancelled') return
    await releaseClaim(input.repoPath, result.beadId).catch(() => undefined)
    updateRunStatus(this.db, run.id, 'paused', result.reason)
    this.publish(run.id, 'paused')
  }
  private async handleFailure(
    run: any,
    input: StartRunInput,
    item: IterationResult,
    output: string,
    classification: 'code' | 'infra' | 'unknown',
    config: {
      gateCommand?: string | string[]
      installCommand?: string | string[]
    },
  ) {
    const signature = failureSignature(output, input.repoPath)
    const previous = readSignatures(input.config, item.beadId)
    const entry: FailureEntry = {
      attempt: previous.length + 1,
      signature,
      excerpt: output.slice(0, 1000),
    }
    input.config = rememberSignature(input.config, item.beadId, entry)
    updateRunConfig(this.db, run.id, input.config)
    if (
      classification === 'infra' &&
      isDependencyFailure(output) &&
      config.installCommand &&
      !previous.some((value) => value.signature === signature)
    ) {
      const install = await runGate(item.worktreePath, config.installCommand)
      if (install.code === 0 && config.gateCommand) {
        const retry = await runGate(item.worktreePath, config.gateCommand)
        if (retry.code === 0) return false
        output = retry.output
      }
    }
    const attempts = previous.length + 1
    const repeated = previous.some((value) => value.signature === signature)
    settleIteration(
      this.db,
      item.id,
      classification === 'infra' ? 'interrupted' : 'failed',
      output,
    )
    if (attempts < 2 && !repeated && classification === 'code') return true
    let origin =
      run.origin_session_id ??
      run.originSessionId ??
      this.db
        .prepare(
          'SELECT id FROM sessions WHERE epic_run_id = ? ORDER BY created_at LIMIT 1',
        )
        .get(run.id)?.id
    if (!origin) {
      const root = createSession(this.db, {
        projectId: run.project_id,
        harness: 'none',
        cwd: input.repoPath,
        title: 'Epic triage',
        kind: 'epic_worker',
        now: Date.now(),
      })
      origin = root.id
    }
    const card = triageCard({
      runId: run.id,
      beadId: item.beadId,
      attempts,
      classification,
      failureChain: [...previous, entry],
    })
    if (origin) {
      appendTriageCard(this.db, origin, card)
      updateRunStatus(this.db, run.id, 'paused', output)
      this.publish(run.id, 'paused')
    } else await this.fail(run.id, output)
    return true
  }
  private async dispatch(
    run: any,
    input: StartRunInput,
    bead: any,
    signal: AbortSignal,
  ): Promise<DispatchResult> {
    const worktree = await createWorktree(
      input.repoPath,
      run.id,
      bead.id,
      input.baseBranch,
    )
    const before = await git(worktree.worktreePath, ['rev-parse', 'HEAD'])
    await claim(input.repoPath, bead.id)
    const attempts = await runPromptAttempts(this.db, this.sessions, {
      requiresAccount: this.requiresAccount,
      run,
      input,
      bead,
      cwd: worktree.worktreePath,
      branch: worktree.branch,
      signal,
      setWorker: (id, session) => this.workerSessions.set(id, session),
      clearWorker: (id) => this.workerSessions.delete(id),
    })
    const iteration = attempts.iteration
    const promptError = attempts.promptError
    try {
      if (promptError) {
        if (signal.aborted) {
          if (iteration)
            settleIteration(
              this.db,
              iteration.id,
              'interrupted',
              'Run cancelled',
            )
          return { kind: 'cancelled', beadId: bead.id }
        }
        const reason = `All configured fallback hops failed: ${String(promptError)}`
        return { kind: 'failed', beadId: bead.id, reason }
      }
      const closed = (await show(input.repoPath, bead.id)).status === 'closed'
      const commits = Number(
        await git(worktree.worktreePath, [
          'rev-list',
          '--count',
          `${before}..${worktree.branch}`,
        ]),
      )
      const evidence =
        commits > 0 ||
        (await hasCommentSince(
          input.repoPath,
          bead.id,
          new Date(iteration!.startedAt).toISOString(),
        ))
      if (signal.aborted) {
        settleIteration(this.db, iteration!.id, 'interrupted', 'Run cancelled')
        if (!closed) await releaseClaim(input.repoPath, bead.id)
        return { kind: 'cancelled', beadId: bead.id }
      }
      if (!closed || !evidence) {
        const reason = 'Child closed without a commit or comment evidence'
        settleIteration(this.db, iteration!.id, 'failed', reason)
        return { kind: 'failed', beadId: bead.id, reason }
      }
      return {
        kind: 'ready',
        item: {
          id: iteration!.id,
          branch: worktree.branch,
          beadId: bead.id,
          worktreePath: worktree.worktreePath,
        },
      }
    } catch (error) {
      if (iteration)
        settleIteration(
          this.db,
          iteration.id,
          signal.aborted ? 'interrupted' : 'failed',
          errorMessage(error),
        )
      if (!signal.aborted) await releaseClaim(input.repoPath, bead.id)
      return {
        kind: signal.aborted ? 'cancelled' : 'failed',
        beadId: bead.id,
        ...(signal.aborted ? {} : { reason: errorMessage(error) }),
      } as DispatchResult
    } finally {
      if (iteration) this.workerSessions.delete(iteration.id)
    }
  }
  private async probeRadar(
    runId: string,
    input: StartRunInput,
    heads: Map<string, string>,
  ) {
    const rows = this.db
      .prepare(
        "SELECT * FROM epic_iterations WHERE epic_run_id = ? AND status = 'running'",
      )
      .all(runId)
    for (const row of rows) {
      const head = await git(input.repoPath, ['rev-parse', row.branch]).catch(
        () => '',
      )
      const base = await git(input.repoPath, [
        'rev-parse',
        input.baseBranch,
      ]).catch(() => '')
      const key = `${base}:${head}`
      if (heads.get(row.id) === key) continue
      heads.set(row.id, key)
      const conflict = await trialMerge(
        input.repoPath,
        input.baseBranch,
        row.branch,
      )
      if (conflict !== 'clean') {
        const nudges = Number(row.radar_nudges ?? 0)
        if (nudges < 2) {
          const session = this.workerSessions.get(row.id)
          if (session) {
            await session.prompt(
              `Merge ${input.baseBranch} into your branch now. Conflicts: ${(conflict as ConflictReport).files.join(', ')}`,
              'turn-boundary',
            )
            this.db
              .prepare(
                'UPDATE epic_iterations SET radar_nudges = ? WHERE id = ?',
              )
              .run(nudges + 1, row.id)
          }
        }
      }
    }
  }
  async pause(runId: string) {
    const item = this.active.get(runId)
    item?.abort.abort()
    updateRunStatus(this.db, runId, 'paused')
    this.publish(runId, 'paused')
  }
  async cancel(runId: string) {
    const item = this.active.get(runId)
    const input = this.inputs.get(runId)
    item?.abort.abort()
    const sessions = new Set<WorkerSession>()
    if (item?.session) sessions.add(item.session)
    const iterations = this.db
      .prepare(
        "SELECT id FROM epic_iterations WHERE epic_run_id = ? AND status = 'running'",
      )
      .all(runId)
    for (const iteration of iterations) {
      const session = this.workerSessions.get(iteration.id)
      if (session) sessions.add(session)
    }
    await Promise.all(
      [...sessions].map((session) => session.cancel().catch(() => undefined)),
    )
    if (input) await this.cleanupRunWorktrees(runId, input.repoPath)
    updateRunStatus(this.db, runId, 'cancelled')
    this.publish(runId, 'cancelled')
  }
  async resume(runId: string, skipBead?: string) {
    const input = this.inputs.get(runId)
    if (!input) throw new Error('Run configuration is not available')
    const row = this.db
      .prepare('SELECT * FROM epic_runs WHERE id = ?')
      .get(runId)
    if (!row) throw new Error('Run not found')
    if (this.active.has(runId)) return
    if (skipBead) {
      const skipped = this.skippedBeads.get(runId) ?? new Set<string>()
      skipped.add(skipBead)
      this.skippedBeads.set(runId, skipped)
      await releaseClaim(input.repoPath, skipBead).catch(() => {})
    }
    updateRunStatus(this.db, runId, 'running')
    const abort = new AbortController()
    this.active.set(runId, { abort })
    void this.loop({ ...row, id: runId }, input, abort.signal).catch(
      (error) => void this.fail(runId, errorMessage(error)),
    )
  }
  private async fail(runId: string, reason: string) {
    updateRunStatus(this.db, runId, 'failed', reason)
    this.publish(runId, 'failed')
  }
  private publish(
    runId: string,
    status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled',
  ) {
    this.bus.publishEphemeral({
      type: 'epicRunStatus',
      seq: null,
      runId,
      status,
    })
  }
}
