import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

export const MIME: Record<string, string> = {
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ts': 'text/typescript',
  '.txt': 'text/plain',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
}

export async function safePath(
  rootInput: string,
  input: string,
  directory?: boolean,
) {
  if (isAbsolute(input) || input.includes('\0')) throw new Error('Invalid path')
  const root = await realpath(rootInput)
  const path = await realpath(resolve(root, input || '.'))
  if (path !== root && !path.startsWith(`${root}/`))
    throw new Error('Invalid path')
  const info = await stat(path)
  if (directory !== undefined && info.isDirectory() !== directory)
    throw new Error('Invalid path')
  return { path, info }
}

// Relative-path validation is translated from Comet workspace_files.rs.
// Copyright (c) 2026 Wing. MIT license: THIRD_PARTY_NOTICES.md.
export function relativePath(input: string, directory = false) {
  const parts = input.split('/')
  if (
    (!input && !directory) ||
    Buffer.byteLength(input) > 4096 ||
    parts.length > 256 ||
    input.startsWith('/') ||
    /[\0\\:]/.test(input) ||
    (input && parts.some((part) => !part || part === '.' || part === '..'))
  ) {
    throw new WorkspaceError(
      'invalid_path',
      400,
      'Invalid workspace-relative path',
    )
  }
  if (
    parts.some((part) => part.toLowerCase() === '.git' || ownedTemporary(part))
  )
    throw new WorkspaceError(
      'prohibited_path',
      403,
      'This path is not accessible',
    )
  return input
}

import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, readlink, type FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type {
  ResolvedWorkspace,
  WorkspaceConflictReason,
  WorkspaceErrorCode,
  WorkspaceText,
} from '@forge/protocol/workspace'

export class WorkspaceError extends Error {
  constructor(
    public code: WorkspaceErrorCode,
    public status: 400 | 403 | 404 | 409 | 413 | 429 | 503,
    message: string,
    public workspace?: ResolvedWorkspace,
    public reason?: WorkspaceConflictReason,
    public current?: WorkspaceText,
    public publicationMayHaveHappened?: boolean,
  ) {
    super(message)
  }
}
export const hash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex')
export const identity = (info: BigIntStats) =>
  `${info.dev}:${info.ino}:${info.birthtimeNs}`
export const fileRevision = (info: BigIntStats) =>
  hash(
    `${identity(info)}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.mode}`,
  )
export type OwnedTemporary = {
  path: string
  identity: string
  revision: string | null
}
export async function temporaryMatches(
  owned: OwnedTemporary,
  path = owned.path,
) {
  if (!owned.revision) return false
  const info = await lstat(path, { bigint: true }).catch(() => null)
  return (
    !!info?.isFile() &&
    identity(info) === owned.identity &&
    fileRevision(info) === owned.revision
  )
}
export const ownedTemporary = (name: string) => name.startsWith('.forge-save-')
export const descriptorPath = (handle: FileHandle, name = '') =>
  `/proc/self/fd/${handle.fd}${name ? `/${name}` : ''}`
export type PathHooks = {
  beforeDirectoryOpen?: (relative: string) => Promise<void>
}

export function filesystemError(
  error: unknown,
  workspace?: ResolvedWorkspace,
): WorkspaceError {
  if (error instanceof WorkspaceError) return error
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOENT')
    return new WorkspaceError(
      'file_not_found',
      404,
      'File not found',
      workspace,
    )
  if (['ELOOP', 'ENOTDIR', 'EACCES', 'EPERM'].includes(code ?? ''))
    return new WorkspaceError(
      'prohibited_path',
      403,
      'File access is prohibited',
      workspace,
    )
  return new WorkspaceError(
    'unavailable',
    503,
    'Workspace operation is unavailable',
    workspace,
  )
}

/** Linux descriptor traversal. Retain every ancestor until the operation finishes. */
export class WorkspacePath {
  private handles: FileHandle[] = []
  private identities: string[] = []
  private relatives: string[] = []
  private constructor(
    readonly root: string,
    readonly relative: string,
  ) {}
  static async open(
    root: string,
    rootIdentity: string,
    relative: string,
    directory: boolean,
    signal?: AbortSignal,
    hooks?: PathHooks,
  ) {
    relativePath(relative, directory)
    if (process.platform !== 'linux' || !constants.O_NOFOLLOW)
      throw new WorkspaceError(
        'unavailable',
        503,
        'Safe descriptor access is unavailable on this platform',
      )
    const chain = new WorkspacePath(root, relative)
    try {
      signal?.throwIfAborted()
      const rootHandle = await open(
        root,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      )
      chain.handles.push(rootHandle)
      chain.identities.push(identity(await rootHandle.stat({ bigint: true })))
      chain.relatives.push('')
      if (chain.identities[0] !== rootIdentity)
        throw new WorkspaceError(
          'conflict',
          409,
          'Workspace root changed',
          undefined,
          'workspace_changed',
        )
      await chain.verify()
      const parts = relative ? relative.split('/') : []
      const directories = directory ? parts : parts.slice(0, -1)
      for (let index = 0; index < directories.length; index++) {
        signal?.throwIfAborted()
        const name = directories[index]!
        const child = descriptorPath(chain.parent, name)
        const before = await lstat(child, { bigint: true })
        if (!before.isDirectory())
          throw new WorkspaceError(
            'prohibited_path',
            403,
            'Directory links are not accessible',
          )
        const rel = directories.slice(0, index + 1).join('/')
        await hooks?.beforeDirectoryOpen?.(rel)
        const handle = await open(
          child,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        )
        chain.handles.push(handle)
        chain.identities.push(identity(before))
        chain.relatives.push(rel)
        if (identity(await handle.stat({ bigint: true })) !== identity(before))
          throw new WorkspaceError(
            'conflict',
            409,
            'Parent directory changed',
            undefined,
            'replaced',
          )
      }
      await chain.verify()
      return chain
    } catch (error) {
      await chain.close()
      throw filesystemError(error)
    }
  }
  get parent() {
    return this.handles.at(-1)!
  }
  get leaf() {
    return descriptorPath(this.parent, this.relative.split('/').at(-1)!)
  }
  async verify() {
    for (let i = 0; i < this.handles.length; i++) {
      const handle = this.handles[i]!
      const expected = this.relatives[i]
        ? `${this.root}/${this.relatives[i]}`
        : this.root
      if (
        identity(await handle.stat({ bigint: true })) !== this.identities[i] ||
        (await readlink(descriptorPath(handle))) !== expected
      )
        throw new WorkspaceError(
          'conflict',
          409,
          'Workspace directory changed',
          undefined,
          'replaced',
        )
    }
    // Compare the current root entry too. An open descriptor can outlive a replaced root.
    if (
      identity(await lstat(this.root, { bigint: true })) !== this.identities[0]
    )
      throw new WorkspaceError(
        'conflict',
        409,
        'Workspace root changed',
        undefined,
        'workspace_changed',
      )
  }
  async openFile() {
    await this.verify()
    const before = await lstat(this.leaf, { bigint: true })
    if (!before.isFile())
      throw new WorkspaceError(
        'prohibited_path',
        403,
        'Only regular files are accessible',
        undefined,
        'not_regular_file',
      )
    const handle = await open(
      this.leaf,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const info = await handle.stat({ bigint: true })
      if (!info.isFile() || identity(info) !== identity(before))
        throw new WorkspaceError(
          'conflict',
          409,
          'File was replaced',
          undefined,
          'replaced',
        )
      await this.verify()
      return { handle, info }
    } catch (error) {
      await handle.close()
      throw error
    }
  }
  async close() {
    await Promise.allSettled(
      this.handles
        .splice(0)
        .reverse()
        .map((handle) => handle.close()),
    )
  }
}
