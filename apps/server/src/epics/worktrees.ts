import { hostname } from 'node:os'
import {
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'

declare const Bun: {
  spawn(
    command: string[],
    options: { cwd: string; stdout: 'pipe'; stderr: 'pipe' },
  ): {
    stdout: ReadableStream<Uint8Array>
    stderr: ReadableStream<Uint8Array>
    exited: Promise<number>
  }
  write(path: string, data: string): Promise<number>
}

const HUNKS_LIMIT = 32 * 1024

export type ConflictReport = {
  files: string[]
  mergeOutput: string
  hunks: string
}

export type MergeResult = 'clean' | ConflictReport

export class RunLockHeldError extends Error {
  readonly holder: RunLockMetadata

  constructor(holder: RunLockMetadata) {
    super(
      `Forge run lock is held by ${holder.owner} (pid ${holder.pid}, run ${holder.runId})`,
    )
    this.name = 'RunLockHeldError'
    this.holder = holder
  }
}

export type RunLockMetadata = {
  pid: number
  pgid: number
  host: string
  bootId: string
  startedAt: string
  heartbeatAt: string
  owner: 'forge'
  runId: string
}

export type RunLock = RunLockMetadata & {
  heartbeat(): Promise<void>
  release(): Promise<void>
}

async function git(
  repoPath: string,
  args: string[],
  check = true,
): Promise<{ output: string; code: number }> {
  const proc = Bun.spawn(['git', ...args], {
    cwd: repoPath,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const output = stdout + stderr
  if (check && code !== 0)
    throw new Error(`git ${args.join(' ')} failed (${code}): ${output}`)
  return { output, code }
}

function runRoot(repoPath: string, runId: string): string {
  return join(repoPath, 'worktrees', `epic-${runId}`)
}

export async function createWorktree(
  repoPath: string,
  runId: string,
  childId: string,
): Promise<{ branch: string; worktreePath: string }> {
  const branch = `epic/${childId}`
  const worktreePath = join(runRoot(repoPath, runId), childId)
  await mkdir(resolve(worktreePath, '..'), { recursive: true })
  await git(repoPath, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'])
  return { branch, worktreePath }
}

export async function resetToBranchHead(worktreePath: string): Promise<void> {
  await git(worktreePath, ['reset', '--hard', 'HEAD'])
  await git(worktreePath, ['clean', '-fd'])
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  deleteBranch = false,
): Promise<void> {
  let branch: string | undefined
  if (deleteBranch) {
    const result = await git(worktreePath, ['branch', '--show-current'], false)
    branch = result.output.trim() || undefined
  }
  await git(repoPath, ['worktree', 'remove', '--force', worktreePath])
  if (deleteBranch && branch) await git(repoPath, ['branch', '-D', branch])
}

export async function listRunWorktrees(
  repoPath: string,
  runId: string,
): Promise<string[]> {
  const root = runRoot(repoPath, runId)
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function conflictReport(
  repoPath: string,
  output: string,
): Promise<ConflictReport> {
  const status = await git(
    repoPath,
    ['diff', '--name-only', '--diff-filter=U'],
    false,
  )
  const files = status.output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const hunksResult = await git(
    repoPath,
    ['diff', '--no-ext-diff', '--no-color', '--', ...files],
    false,
  )
  return {
    files,
    mergeOutput: output,
    hunks: hunksResult.output.slice(0, HUNKS_LIMIT),
  }
}

export async function mergeBranch(
  repoPath: string,
  baseBranch: string,
  branch: string,
): Promise<MergeResult> {
  const id = `${Date.now()}-${process.pid}`
  const integration = join(repoPath, 'worktrees', `epic-${id}`, 'integration')
  await mkdir(resolve(integration, '..'), { recursive: true })
  // The base branch is normally checked out by the user's main worktree.
  // Use a detached integration worktree, then move the ref after the merge.
  await git(repoPath, ['worktree', 'add', '--detach', integration, baseBranch])
  try {
    const merged = await git(integration, ['merge', '--no-edit', branch], false)
    if (merged.code !== 0) {
      const report = await conflictReport(integration, merged.output)
      await git(integration, ['merge', '--abort'], false)
      return report
    }
    const head = (await git(integration, ['rev-parse', 'HEAD'])).output.trim()
    await git(repoPath, ['update-ref', `refs/heads/${baseBranch}`, head])
    return 'clean'
  } finally {
    await git(repoPath, ['worktree', 'remove', '--force', integration], false)
    await rm(resolve(integration, '..'), { recursive: true, force: true })
  }
}

export async function trialMerge(
  repoPath: string,
  baseBranch: string,
  branch: string,
): Promise<MergeResult> {
  const result = await git(
    repoPath,
    ['merge-tree', '--write-tree', baseBranch, branch],
    false,
  )
  if (result.code === 0) return 'clean'
  const files = result.output
    .split('\n')
    .filter((line) => /^\d{6} [0-9a-f]+ \d+\t/.test(line))
    .map((line) => line.slice(line.indexOf('\t') + 1).trim())
    .filter((line, index, all) => line && all.indexOf(line) === index)
  return {
    files,
    mergeOutput: result.output,
    hunks: result.output.slice(0, HUNKS_LIMIT),
  }
}

async function bootId(): Promise<string> {
  return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
}

async function processStart(pid: number): Promise<string | undefined> {
  try {
    return (await readFile(`/proc/${pid}/stat`, 'utf8')).trim().split(' ')[21]
  } catch {
    return undefined
  }
}

async function processGroupExists(pgid: number): Promise<boolean> {
  try {
    await stat(`/proc/${pgid}`)
    return true
  } catch {
    return false
  }
}

async function reclaimable(
  lock: RunLockMetadata,
  currentBoot: string,
): Promise<boolean> {
  if (lock.host !== hostname()) return false
  if (lock.bootId !== currentBoot) return true
  const start = await processStart(lock.pid)
  if (start !== undefined) return false
  return !(await processGroupExists(lock.pgid))
}

async function readLock(path: string): Promise<RunLockMetadata> {
  return JSON.parse(await readFile(path, 'utf8')) as RunLockMetadata
}

export async function acquireRunLock(
  repoPath: string,
  epicId: string,
  meta: { runId: string; pid?: number; pgid?: number },
): Promise<RunLock> {
  const path = join(repoPath, '.beads', `run-lock.${epicId}.json`)
  await mkdir(resolve(path, '..'), { recursive: true })
  const now = new Date().toISOString()
  const lock: RunLockMetadata = {
    pid: meta.pid ?? process.pid,
    pgid: meta.pgid ?? process.pid,
    host: hostname(),
    bootId: await bootId(),
    startedAt: now,
    heartbeatAt: now,
    owner: 'forge',
    runId: meta.runId,
  }
  try {
    const handle = await open(path, 'wx')
    await handle.writeFile(JSON.stringify(lock))
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = await readLock(path)
    const canReclaim = await reclaimable(existing, lock.bootId)
    // A dead holder can be reclaimed at once. A live holder remains valid.
    if (!canReclaim) throw new RunLockHeldError(existing)
    await unlink(path)
    const handle = await open(path, 'wx')
    await handle.writeFile(JSON.stringify(lock))
    await handle.close()
  }
  let released = false
  let timer: ReturnType<typeof setInterval> | undefined
  const heartbeat = async () => {
    if (released) return
    try {
      const current = await readLock(path)
      if (current.pid !== lock.pid || current.runId !== lock.runId) return
    } catch {
      return
    }
    const next = { ...lock, heartbeatAt: new Date().toISOString() }
    await Bun.write(path, JSON.stringify(next))
    lock.heartbeatAt = next.heartbeatAt
  }
  timer = setInterval(() => void heartbeat(), 30_000)
  return {
    ...lock,
    async heartbeat() {
      await heartbeat()
    },
    async release() {
      if (released) return
      released = true
      if (timer) clearInterval(timer)
      try {
        const current = await readLock(path)
        if (current.pid === lock.pid && current.runId === lock.runId)
          await unlink(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    },
  }
}
