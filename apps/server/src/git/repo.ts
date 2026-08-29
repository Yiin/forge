import { runGit } from './exec.js'

export type GitStatus = {
  isRepo: boolean
  branch: string | null
  defaultBranch: string | null
  hasRemote: boolean
  detached: boolean
  dirty: boolean
}

export type GitRef = {
  name: string
  current: boolean
  isDefault: boolean
  isRemote: boolean
  remoteName: string | null
  worktreePath: string | null
}

export type GitRefsPage = {
  isRepo: boolean
  hasRemote: boolean
  refs: GitRef[]
  nextCursor: number | null
  totalCount: number
}

const emptyStatus = (): GitStatus => ({
  isRepo: false,
  branch: null,
  defaultBranch: null,
  hasRemote: false,
  detached: false,
  dirty: false,
})

async function defaultBranch(cwd: string) {
  const result = await runGit(
    cwd,
    ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
    false,
  )
  const ref = result.output.trim()
  return result.code === 0 && ref.startsWith('refs/remotes/origin/')
    ? ref.slice('refs/remotes/origin/'.length)
    : null
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const probe = await runGit(cwd, ['rev-parse', '--git-dir'], false)
  if (probe.code !== 0) return emptyStatus()
  const [branchResult, remoteResult, dirtyResult, main] = await Promise.all([
    runGit(cwd, ['branch', '--show-current']),
    runGit(cwd, ['remote']),
    runGit(cwd, ['status', '--porcelain']),
    defaultBranch(cwd),
  ])
  const branch = branchResult.output.trim()
  return {
    isRepo: true,
    branch: branch || null,
    defaultBranch: main,
    hasRemote: remoteResult.output.split(/\r?\n/).some((line) => line.trim() === 'origin'),
    detached: !branch,
    dirty: dirtyResult.output.trim().length > 0,
  }
}

function worktreeBranches(output: string) {
  const paths = new Map<string, string>()
  for (const block of output.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/)
    const path = lines.find((line) => line.startsWith('worktree '))?.slice(9)
    const branch = lines
      .find((line) => line.startsWith('branch refs/heads/'))
      ?.slice('branch refs/heads/'.length)
    if (path && branch) paths.set(branch, path)
  }
  return paths
}

export async function listRefs(
  cwd: string,
  options: { query?: string; limit?: number; cursor?: number } = {},
): Promise<GitRefsPage> {
  const probe = await runGit(cwd, ['rev-parse', '--git-dir'], false)
  if (probe.code !== 0)
    return { isRepo: false, hasRemote: false, refs: [], nextCursor: null, totalCount: 0 }
  const [local, remote, worktrees, status] = await Promise.all([
    runGit(cwd, ['branch', '--no-color', '--no-column']),
    runGit(cwd, ['branch', '--no-color', '--no-column', '--remotes']),
    runGit(cwd, ['worktree', 'list', '--porcelain']),
    gitStatus(cwd),
  ])
  const paths = worktreeBranches(worktrees.output)
  const refs: GitRef[] = []
  for (const line of local.output.split(/\r?\n/)) {
    if (!line.trim()) continue
    const current = line.startsWith('* ')
    const name = line.replace(/^[*+]\s+/, '').trim()
    refs.push({ name, current, isDefault: name === status.defaultBranch, isRemote: false, remoteName: null, worktreePath: paths.get(name) ?? null })
  }
  for (const line of remote.output.split(/\r?\n/)) {
    const name = line.replace(/^\s+/, '').trim()
    if (!name || name.endsWith('/HEAD')) continue
    const slash = name.indexOf('/')
    const remoteName = slash < 0 ? name : name.slice(0, slash)
    refs.push({ name, current: false, isDefault: false, isRemote: true, remoteName, worktreePath: null })
  }
  const query = options.query?.toLocaleLowerCase()
  const filtered = query ? refs.filter((ref) => ref.name.toLocaleLowerCase().includes(query)) : refs
  filtered.sort((a, b) => Number(b.current) - Number(a.current) || Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
  const cursor = Math.max(0, options.cursor ?? 0)
  const limit = Math.min(200, Math.max(1, options.limit ?? 50))
  const page = filtered.slice(cursor, cursor + limit)
  const next = cursor + page.length < filtered.length ? cursor + page.length : null
  return { isRepo: true, hasRemote: status.hasRemote, refs: page, nextCursor: next, totalCount: filtered.length }
}
