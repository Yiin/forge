import { access } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  createIteration,
  settleIteration,
  updateRunStatus,
} from '../db/queries.js'
import { show } from './beads.js'
import {
  acquireRunLock,
  listRunWorktrees,
  removeWorktree,
  resetToBranchHead,
} from './worktrees.js'

const exec = promisify(execFile)

type Db = {
  exec(sql: string): unknown
  prepare(sql: string): {
    get(...args: unknown[]): any
    all(...args: unknown[]): any[]
  }
}

export type EpicRecoverySession = {
  id: string
}

export type EpicRecoveryOptions = {
  createWorkerSession?: (input: {
    run: any
    bead: any
    cwd: string
  }) => Promise<EpicRecoverySession>
  /** Create the fresh worker session and run the bead. */
  redispatch?: (input: {
    run: any
    iteration: any
    bead: any
    worktreePath: string
    branch: string
  }) => Promise<void>
  /** Hand a closed bead with verified branch effects to the normal merge queue. */
  enqueueMerge?: (input: {
    run: any
    iteration: any
    beadId: string
    branch: string
    worktreePath: string
  }) => Promise<void>
}

async function git(repoPath: string, args: string[]) {
  return (await exec('git', args, { cwd: repoPath })).stdout.trim()
}

async function preflight(
  repoPath: string,
  epicBeadId: string,
  baseBranch: string,
) {
  try {
    await access(repoPath)
    await git(repoPath, ['rev-parse', '--is-inside-work-tree'])
    await git(repoPath, ['rev-parse', '--verify', baseBranch])
    await show(repoPath, epicBeadId)
  } catch (error) {
    throw new Error(
      `recovery preflight failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function branchHasEffects(
  repoPath: string,
  baseBranch: string,
  branch: string,
) {
  try {
    return (
      Number(
        await git(repoPath, [
          'rev-list',
          '--count',
          `${baseBranch}..${branch}`,
        ]),
      ) > 0
    )
  } catch {
    return false
  }
}

/** Recover interrupted epic work after a process or host restart. */
export async function recoverEpicRuns(
  db: Db,
  options: EpicRecoveryOptions = {},
): Promise<void> {
  const runs = db
    .prepare("SELECT * FROM epic_runs WHERE status = 'running'")
    .all()

  // Crash leftovers from terminal runs must never be dispatched again.
  const terminal = db
    .prepare(
      "SELECT * FROM epic_runs WHERE status IN ('completed', 'failed', 'cancelled')",
    )
    .all()
  for (const run of terminal) {
    const project = db
      .prepare('SELECT path FROM projects WHERE id = ?')
      .get(run.project_id) as { path?: string } | undefined
    if (!project?.path) continue
    for (const path of await listRunWorktrees(project.path, run.id)) {
      await removeWorktree(project.path, path, false).catch(() => undefined)
    }
    // A crashed terminal run can also leave its lock behind. A live holder
    // is never removed because acquireRunLock refuses to reclaim it.
    await acquireRunLock(project.path, run.epic_bead_id, { runId: run.id })
      .then((lock) => lock.release())
      .catch(() => undefined)
  }

  for (const run of runs) {
    const project = db
      .prepare('SELECT path FROM projects WHERE id = ?')
      .get(run.project_id) as { path?: string } | undefined
    const repoPath = project?.path
    const iterations = db
      .prepare(
        "SELECT * FROM epic_iterations WHERE epic_run_id = ? AND status = 'running'",
      )
      .all(run.id)

    for (const iteration of iterations)
      settleIteration(db, iteration.id, 'interrupted', 'server-restart')

    if (!repoPath) {
      updateRunStatus(
        db,
        run.id,
        'paused',
        'recovery preflight failed: project path not found',
      )
      continue
    }
    let lock: Awaited<ReturnType<typeof acquireRunLock>>
    try {
      await preflight(repoPath, run.epic_bead_id, run.base_branch)
      lock = await acquireRunLock(repoPath, run.epic_bead_id, { runId: run.id })
    } catch (error) {
      updateRunStatus(
        db,
        run.id,
        'paused',
        error instanceof Error ? error.message : String(error),
      )
      continue
    }

    try {
      for (const old of iterations) {
        await resetToBranchHead(old.worktree_path).catch(() => undefined)
        const bead = await show(repoPath, old.bead_id)
        const effects = await branchHasEffects(
          repoPath,
          run.base_branch,
          old.branch,
        )
        if (bead.status === 'closed' && effects) {
          await options.enqueueMerge?.({
            run,
            iteration: old,
            beadId: old.bead_id,
            branch: old.branch,
            worktreePath: old.worktree_path,
          })
          continue
        }
        const session = await options.createWorkerSession?.({
          run,
          bead,
          cwd: old.worktree_path,
        })
        const next = createIteration(db, {
          runId: run.id,
          beadId: old.bead_id,
          sessionId: session?.id ?? old.session_id,
          worktreePath: old.worktree_path,
          branch: old.branch,
          attempt: Number(old.attempt) + 1,
        })
        await options.redispatch?.({
          run,
          iteration: next,
          bead,
          worktreePath: old.worktree_path,
          branch: old.branch,
        })
      }
    } finally {
      await lock.release()
    }
  }
}
