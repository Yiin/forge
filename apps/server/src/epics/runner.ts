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
  createIteration,
  createRun,
  settleIteration,
  updateRunStatus,
} from '../db/queries.js'
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
  mode: 'serial' | 'pool'
  workerCount: number
  config: unknown
  originSessionId?: string | null
}
async function git(repo: string, args: string[]) {
  return (await exec('git', args, { cwd: repo })).stdout.trim()
}
export class EpicRunner {
  private active = new Map<
    string,
    { abort: AbortController; session?: WorkerSession }
  >()
  private inputs = new Map<string, StartRunInput>()
  constructor(
    private readonly db: Db,
    private readonly sessions: SessionManager,
    private readonly bus = new EventBus(),
  ) {}
  get eventBus() {
    return this.bus
  }
  async startRun(input: StartRunInput) {
    if (input.mode !== 'serial')
      throw new Error('Only serial epic runs are supported')
    const run = createRun(this.db, {
      projectId: input.projectId,
      epicBeadId: input.epicBeadId,
      status: 'running',
      mode: input.mode,
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
      while (!signal.aborted) {
        const children = await readyChildren(input.repoPath, input.epicBeadId)
        if (!children.length) {
          if (!(await openChildren(input.repoPath, input.epicBeadId)).length) {
            updateRunStatus(this.db, run.id, 'completed')
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
  async pause(runId: string) {
    const item = this.active.get(runId)
    item?.abort.abort()
    updateRunStatus(this.db, runId, 'paused')
    this.publish(runId, 'paused')
  }
  async cancel(runId: string) {
    const item = this.active.get(runId)
    if (item?.session) await item.session.cancel()
    item?.abort.abort()
    updateRunStatus(this.db, runId, 'cancelled')
    this.publish(runId, 'cancelled')
  }
  async resume(runId: string) {
    const input = this.inputs.get(runId)
    if (!input) throw new Error('Run configuration is not available')
    const row = this.db
      .prepare('SELECT * FROM epic_runs WHERE id = ?')
      .get(runId)
    if (!row) throw new Error('Run not found')
    if (this.active.has(runId)) return
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
