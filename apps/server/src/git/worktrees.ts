import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { runGit } from './exec.js'

export async function pruneWorktrees(repoPath: string) {
  try {
    const result = await runGit(repoPath, ['worktree', 'prune'], false)
    return result.code === 0
  } catch {
    return false
  }
}

export async function pruneWorktreesForRepositories(
  repoPaths: Iterable<string>,
  prune: (repoPath: string) => Promise<boolean> = pruneWorktrees,
) {
  await Promise.all(
    [...new Set(repoPaths)].map(async (repoPath) => {
      await prune(repoPath).catch(() => false)
    }),
  )
}

export function temporaryWorktreeBranchName() {
  return `forge/${randomBytes(4).toString('hex')}`
}

export function isTemporaryWorktreeBranch(name: string) {
  return /^forge\/[a-f0-9]{8}$/.test(name)
}

export async function deleteMergedTemporaryBranch(input: {
  repoPath: string
  branch: string
  defaultBranch: string | null
  hasSessionReference: boolean
}) {
  if (
    !isTemporaryWorktreeBranch(input.branch) ||
    !input.defaultBranch ||
    input.hasSessionReference
  )
    return false

  const merged = await runGit(
    input.repoPath,
    ['merge-base', '--is-ancestor', input.branch, input.defaultBranch],
    false,
  )
  if (merged.code !== 0) return false
  await runGit(input.repoPath, ['branch', '-d', input.branch])
  return true
}

export const MAX_SESSION_WORKTREES_PER_PROJECT = 16

export class WorktreeLimitError extends Error {
  readonly status = 409

  constructor(projectId: string) {
    super(
      `Project ${projectId} already has ${MAX_SESSION_WORKTREES_PER_PROJECT} session worktrees`,
    )
    this.name = 'WorktreeLimitError'
  }
}

export class WorktreeRemovalError extends Error {
  readonly status = 409

  constructor(message: string) {
    super(message)
    this.name = 'WorktreeRemovalError'
  }
}

const provisioningLocks = new Map<string, Promise<void>>()

export function worktreePathFor(
  dataDir: string,
  projectId: string,
  branch: string,
) {
  return join(dataDir, 'worktrees', projectId, branch.replaceAll('/', '-'))
}

export async function listWorktrees(repoPath: string) {
  const result = await runGit(repoPath, ['worktree', 'list', '--porcelain'])
  const worktrees: Array<{
    path: string
    branch: string | null
    detached: boolean
  }> = []
  for (const block of result.output.trim().split(/\r?\n\r?\n/)) {
    const path = block
      .split(/\r?\n/)
      .find((line) => line.startsWith('worktree '))
      ?.slice(9)
    if (!path || path === repoPath) continue
    const branch =
      block
        .split(/\r?\n/)
        .find((line) => line.startsWith('branch refs/heads/'))
        ?.slice(18) ?? null
    worktrees.push({ path, branch, detached: branch === null })
  }
  return worktrees
}

export async function provisionWorktree(input: {
  repoPath: string
  dataDir: string
  projectId: string
  baseRef: string
  branch?: string
}) {
  const lockKey = `${resolve(input.repoPath)}\0${input.projectId}`
  const previous = provisioningLocks.get(lockKey)
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  provisioningLocks.set(lockKey, current)
  if (previous) await previous
  try {
    const branch = input.branch ?? temporaryWorktreeBranchName()
    const path = worktreePathFor(input.dataDir, input.projectId, branch)
    const worktrees = await listWorktrees(input.repoPath)
    const sessionRoot = resolve(input.dataDir, 'worktrees', input.projectId)
    const sessionRootPrefix = `${sessionRoot}/`
    const sessionWorktreeCount = worktrees.filter((worktree) =>
      resolve(worktree.path).startsWith(sessionRootPrefix),
    ).length
    if (sessionWorktreeCount >= MAX_SESSION_WORKTREES_PER_PROJECT)
      throw new WorktreeLimitError(input.projectId)
    const registered = worktrees.some((worktree) => worktree.path === path)
    if (existsSync(path) || registered)
      throw new Error(`Worktree target already exists: ${path}`)
    await mkdir(join(input.dataDir, 'worktrees', input.projectId), {
      recursive: true,
    })
    const existing = await runGit(
      input.repoPath,
      ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      false,
    )
    if (existing.code === 0)
      await runGit(input.repoPath, ['worktree', 'add', path, branch])
    else
      await runGit(input.repoPath, [
        'worktree',
        'add',
        '-b',
        branch,
        path,
        input.baseRef,
      ])
    return { path, branch }
  } finally {
    release()
    if (provisioningLocks.get(lockKey) === current)
      provisioningLocks.delete(lockKey)
  }
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  force = false,
) {
  await runGit(repoPath, [
    'worktree',
    'remove',
    ...(force ? ['--force'] : []),
    worktreePath,
  ])
}
