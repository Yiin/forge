import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { runGit } from './exec.js'
import type { GitDiff, GitDiffFile, GitContent } from '@forge/protocol/git'

const MAX_PATCH_BYTES = 8 * 1024 * 1024
const MAX_CONTENT_BYTES = 1024 * 1024
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

function safePath(path: string) {
  if (!path || path.startsWith('/') || path.split('/').includes('..'))
    throw new Error('Invalid Git path')
  return path
}

function revisionOf(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
function unquote(value: string) {
  if (!value.startsWith('"')) return value
  try {
    return JSON.parse(value) as string
  } catch {
    return value.slice(1, -1)
  }
}
function pathFromHeader(value: string, prefix: string) {
  return unquote(value).startsWith(prefix)
    ? unquote(value).slice(prefix.length)
    : unquote(value)
}

function parsePatch(patch: string): GitDiffFile[] {
  const files: GitDiffFile[] = []
  let current: GitDiffFile | undefined
  let hunk: GitDiffFile['hunks'][number] | undefined
  let oldLine = 0
  let newLine = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git (.+) (.+)$/)
      if (!match) continue
      const oldPath = pathFromHeader(match[1]!, 'a/')
      const newPath = pathFromHeader(match[2]!, 'b/')
      current = {
        oldPath: oldPath === '/dev/null' ? null : oldPath,
        newPath: newPath === '/dev/null' ? null : newPath,
        status: 'modified',
        hunks: [],
        additions: 0,
        deletions: 0,
        oldMode: null,
        newMode: null,
        contentTruncated: false,
      }
      files.push(current)
      hunk = undefined
      continue
    }
    if (!current) continue
    const mode = line.match(/^old mode (\S+)|^new mode (\S+)/)
    if (mode) {
      if (mode[1]) current.oldMode = mode[1]
      if (mode[2]) current.newMode = mode[2]
      continue
    }
    if (
      line.startsWith('similarity index') ||
      line.startsWith('rename from ')
    ) {
      current.status = 'renamed'
      if (line.startsWith('rename from ')) current.oldPath = line.slice(12)
      continue
    }
    if (line.startsWith('copy from ')) {
      current.status = 'copied'
      continue
    }
    if (line.startsWith('--- ')) {
      const path = line.slice(4).split('\t', 1)[0]!
      current.oldPath = path === '/dev/null' ? null : pathFromHeader(path, 'a/')
      continue
    }
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).split('\t', 1)[0]!
      current.newPath = path === '/dev/null' ? null : pathFromHeader(path, 'b/')
      continue
    }
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      current.status = 'binary'
      continue
    }
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[3])
      hunk = {
        oldStart: oldLine,
        oldCount: Number(header[2] ?? 1),
        newStart: newLine,
        newCount: Number(header[4] ?? 1),
        lines: [],
      }
      current.hunks.push(hunk)
      continue
    }
    if (
      !hunk ||
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('\\')
    )
      continue
    const type =
      line[0] === '+' ? 'addition' : line[0] === '-' ? 'deletion' : 'context'
    const text = line.slice(1)
    hunk.lines.push({
      type,
      text,
      oldLine: type === 'addition' ? null : oldLine,
      newLine: type === 'deletion' ? null : newLine,
    })
    if (type === 'addition') {
      current.additions++
      newLine++
    } else if (type === 'deletion') {
      current.deletions++
      oldLine++
    } else {
      oldLine++
      newLine++
    }
  }
  for (const file of files) {
    if (file.oldPath === null) file.status = 'added'
    else if (file.newPath === null) file.status = 'deleted'
    else if (file.status === 'modified' && file.oldMode === '160000')
      file.status = 'submodule'
  }
  return files
}

async function head(cwd: string) {
  const result = await runGit(cwd, ['rev-parse', '--verify', 'HEAD'], false, {
    readOnly: true,
    maxOutputBytes: 64 * 1024,
  })
  return result.code === 0 ? result.stdout.trim() : null
}
async function untrackedPatch(cwd: string) {
  const list = await runGit(
    cwd,
    ['ls-files', '--others', '--exclude-standard', '-z'],
    true,
    { readOnly: true, maxOutputBytes: MAX_PATCH_BYTES },
  )
  let patch = ''
  for (const path of list.stdout.split('\0').filter(Boolean)) {
    const result = await runGit(
      cwd,
      [
        'diff',
        '--no-ext-diff',
        '--no-index',
        '--binary',
        '--unified=3',
        '--',
        '/dev/null',
        path,
      ],
      false,
      { readOnly: true, maxOutputBytes: MAX_PATCH_BYTES },
    )
    patch += result.stdout
  }
  return patch
}
export async function gitDiff(input: {
  cwd: string
  scope: 'working' | 'branch' | 'commit'
  baseRef?: string
  commit?: string
}): Promise<GitDiff> {
  const currentHead = await head(input.cwd)
  let args: string[]
  let revision = currentHead ?? 'unborn'
  if (input.scope === 'commit') {
    if (!input.commit) throw new Error('commit is required')
    const resolved = await runGit(
      input.cwd,
      ['rev-parse', '--verify', `${input.commit}^{commit}`],
      true,
      { readOnly: true, maxOutputBytes: 64 * 1024 },
    )
    revision = resolved.stdout.trim()
    const parent = await runGit(
      input.cwd,
      ['rev-list', '--parents', '-n', '1', revision],
      true,
      { readOnly: true, maxOutputBytes: 64 * 1024 },
    )
    args = [
      'diff',
      '--no-ext-diff',
      '--binary',
      '--unified=3',
      parent.stdout.trim().split(/\s+/)[1] ?? EMPTY_TREE,
      revision,
      '--',
    ]
  } else if (input.scope === 'branch') {
    if (!input.baseRef) throw new Error('baseRef is required')
    const base = await runGit(
      input.cwd,
      ['rev-parse', '--verify', `${input.baseRef}^{commit}`],
      true,
      { readOnly: true, maxOutputBytes: 64 * 1024 },
    )
    if (!currentHead)
      return {
        scope: input.scope,
        files: [],
        additions: 0,
        deletions: 0,
        truncated: false,
        revision: 'unborn',
      }
    const merge = await runGit(
      input.cwd,
      ['merge-base', base.stdout.trim(), currentHead],
      true,
      { readOnly: true, maxOutputBytes: 64 * 1024 },
    )
    revision = currentHead
    args = [
      'diff',
      '--no-ext-diff',
      '--binary',
      '--unified=3',
      merge.stdout.trim(),
      currentHead,
      '--',
    ]
  } else {
    args = currentHead
      ? ['diff', '--no-ext-diff', '--binary', '--unified=3', currentHead, '--']
      : ['diff', '--no-ext-diff', '--binary', '--unified=3', '--', '/dev/null']
  }
  const result = await runGit(input.cwd, args, false, {
    readOnly: true,
    maxOutputBytes: MAX_PATCH_BYTES,
  })
  const patch =
    result.stdout +
    (input.scope === 'working' ? await untrackedPatch(input.cwd) : '')
  const files = parsePatch(patch)
  return {
    scope: input.scope,
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    truncated: false,
    revision: revisionOf(`${revision}\0${patch}`),
  }
}
export async function latestTurnDiff(input: {
  cwd: string
  snapshot: { treeId: string | null; state?: string } | null
}): Promise<GitDiff> {
  if (
    !input.snapshot ||
    !input.snapshot.treeId ||
    input.snapshot.state === 'unavailable'
  )
    return {
      scope: 'latest-turn',
      files: [],
      additions: 0,
      deletions: 0,
      truncated: false,
      revision: 'unavailable',
      unavailable: true,
      unavailableReason: 'snapshot_not_found',
    }
  const result = await runGit(
    input.cwd,
    [
      'diff',
      '--no-ext-diff',
      '--binary',
      '--unified=3',
      input.snapshot.treeId,
      '--',
    ],
    false,
    { readOnly: true, maxOutputBytes: MAX_PATCH_BYTES },
  )
  const files = parsePatch(result.stdout)
  return {
    scope: 'latest-turn',
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    truncated: false,
    revision: revisionOf(`${input.snapshot.treeId}\0${result.stdout}`),
  }
}
export async function gitContent(input: {
  cwd: string
  path: string
  side: 'old' | 'new'
  revision?: string
}): Promise<GitContent> {
  const path = safePath(input.path)
  const result =
    input.side === 'old' && input.revision
      ? await runGit(input.cwd, ['show', `${input.revision}:${path}`], false, {
          readOnly: true,
          maxOutputBytes: MAX_CONTENT_BYTES + 1,
        })
      : await readFile(join(input.cwd, path))
          .then((buffer) => ({
            code: 0,
            stdout: buffer.toString('utf8'),
            stderr: '',
          }))
          .catch(() => ({ code: 1, stdout: '', stderr: '' }))
  const bytes = Buffer.byteLength(result.stdout)
  const truncated = bytes > MAX_CONTENT_BYTES
  const text =
    result.code === 0 ? result.stdout.slice(0, MAX_CONTENT_BYTES) : null
  const binary = text !== null && text.includes('\u0000')
  return {
    path: relative(input.cwd, join(input.cwd, path)),
    side: input.side,
    text: binary ? null : text,
    binary,
    truncated,
    revision: input.revision ?? 'working-tree',
  }
}
