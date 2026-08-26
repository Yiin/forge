import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { EventBus } from '../events/bus.js'
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
  appendTriageCard,
  classifyGate,
  failureSignature,
  isDependencyFailure,
  readSignatures,
  rememberSignature,
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
  prompt(text: string): Promise<void>
  cancel(): Promise<void>
}
export type SessionManager = {
  create(input: {
    projectId: string
    cwd: string
    title: string
    kind: 'epic_worker'
    epicRunId: string
  }): Promise<WorkerSession>
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
function providerFor(config: unknown) {
  const value = config as {
    rolePolicy?: {
      roles?: Record<string, string>
      tiers?: Record<string, Array<{ harness: string; model?: string }>>
    }
  }
  const tier = value.rolePolicy?.roles?.['iteration-worker']
  const hop = tier ? value.rolePolicy?.tiers?.[tier]?.[0] : undefined
  return { harness: hop?.harness ?? null, model: hop?.model ?? null }
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
      (error) => void this.fail(run.id, String(error)),
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
        const session = await this.sessions.create({
          projectId: input.projectId,
          cwd: input.repoPath,
          title: bead.title,
          kind: 'epic_worker',
          epicRunId: run.id,
        })
        this.active.get(run.id)!.session = session
        const iteration = createIteration(this.db, {
          runId: run.id,
          beadId: bead.id,
          sessionId: session.id,
          worktreePath: input.repoPath,
          branch: input.baseBranch,
          ...providerFor(input.config),
        })
        try {
          await session.prompt(
            workerPrompt(
              await show(input.repoPath, bead.id),
              input.repoPath,
              input.baseBranch,
            ),
          )
        } catch (error) {
          if (signal.aborted) {
            settleIteration(
              this.db,
              iteration.id,
              'interrupted',
              'Run cancelled',
            )
            await releaseClaim(input.repoPath, bead.id)
            return
          }
          settleIteration(this.db, iteration.id, 'failed', String(error))
          await this.fail(run.id, String(error))
          return
        }
        const closed = (await show(input.repoPath, bead.id)).status === 'closed'
        if (signal.aborted) {
          settleIteration(this.db, iteration.id, 'interrupted', 'Run cancelled')
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
            iteration.id,
            'failed',
            'Child closed without a commit or comment evidence',
          )
          await this.fail(run.id, 'Child effects proof failed')
          return
        }
        settleIteration(this.db, iteration.id, 'merged')
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
    const inFlight = new Map<string, Promise<IterationResult | undefined>>()
    const queue: IterationResult[] = []
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
          const task = this.dispatch(run, input, bead, signal)
          inFlight.set(bead.id, task)
          task
            .then((result) => {
              if (result) queue.push(result)
            })
            .catch(() => {})
        }
        while (queue.length) {
          const item = queue.shift()!
          const config = input.config as {
            gateCommand?: string | string[]
            installCommand?: string | string[]
          }
          if (config?.gateCommand) {
            const branchGate = await runGate(
              item.worktreePath,
              config.gateCommand,
            )
            if (branchGate.code !== 0) {
              const control = await runGate(input.repoPath, config.gateCommand)
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
          const result = await mergeBranch(
            input.repoPath,
            input.baseBranch,
            item.branch,
            undefined,
          )
          if (result !== 'clean') {
            const output = JSON.stringify(result)
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
  ): Promise<IterationResult | undefined> {
    const worktree = await createWorktree(
      input.repoPath,
      run.id,
      bead.id,
      input.baseBranch,
    )
    const before = await git(worktree.worktreePath, ['rev-parse', 'HEAD'])
    await claim(input.repoPath, bead.id)
    const session = await this.sessions.create({
      projectId: input.projectId,
      cwd: worktree.worktreePath,
      title: bead.title,
      kind: 'epic_worker',
      epicRunId: run.id,
    })
    const iteration = createIteration(this.db, {
      runId: run.id,
      beadId: bead.id,
      sessionId: session.id,
      worktreePath: worktree.worktreePath,
      branch: worktree.branch,
      ...providerFor(input.config),
    })
    this.workerSessions.set(iteration.id, session)
    try {
      await session.prompt(
        workerPrompt(
          await show(input.repoPath, bead.id),
          worktree.worktreePath,
          worktree.branch,
        ),
      )
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
          new Date(iteration.startedAt).toISOString(),
        ))
      if (signal.aborted) {
        settleIteration(this.db, iteration.id, 'interrupted', 'Run cancelled')
        if (!closed) await releaseClaim(input.repoPath, bead.id)
        return
      }
      if (!closed || !evidence) {
        settleIteration(
          this.db,
          iteration.id,
          'failed',
          'Child closed without a commit or comment evidence',
        )
        return
      }
      return {
        id: iteration.id,
        branch: worktree.branch,
        beadId: bead.id,
        worktreePath: worktree.worktreePath,
      }
    } catch (error) {
      settleIteration(
        this.db,
        iteration.id,
        signal.aborted ? 'interrupted' : 'failed',
        String(error),
      )
      if (!signal.aborted) await releaseClaim(input.repoPath, bead.id)
      return
    } finally {
      this.workerSessions.delete(iteration.id)
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
    if (item?.session) await item.session.cancel()
    item?.abort.abort()
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
      (error) => void this.fail(runId, String(error)),
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
