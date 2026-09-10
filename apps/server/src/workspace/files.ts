import { KeyedQueue } from '../keyed-queue.js'
import { constants } from 'node:fs'
import {
  lstat,
  open,
  opendir,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  WorkspaceEntry,
  WorkspacePartialReason,
  WorkspaceSave,
  WorkspaceTarget,
  WorkspaceText,
} from '@forge/protocol/workspace'
import { runGit } from '../git/exec.js'
import { rangeResponse } from '../http/rangeStream.js'
import {
  descriptorPath,
  fileRevision,
  filesystemError,
  hash,
  identity,
  MIME,
  ownedTemporary,
  temporaryMatches,
  type OwnedTemporary,
  relativePath,
  WorkspaceError,
  WorkspacePath,
  type PathHooks,
} from './paths.js'
import {
  publicWorkspace,
  WorkspaceTargets,
  type WorkspaceResolution,
} from './target.js'
import { WorkspaceWatches } from './watch.js'
import { WORKSPACE_LIMITS } from './limits.js'
import { WorkspaceOperations } from './operations.js'

export { WORKSPACE_LIMITS } from './limits.js'
export type FileHooks = PathHooks & {
  staged?: (path: string) => Promise<void>
  beforeWatchDirectory?: (path: string) => Promise<void>
  beforeRead?: (handle: FileHandle) => Promise<void>
  writeTemporary?: (write: (length?: number) => Promise<void>) => Promise<void>
  flushTemporary?: (handle: FileHandle) => Promise<void>
  renameTemporary?: (source: string, destination: string) => Promise<void>
  afterPublish?: () => Promise<void>
}
type Expected = {
  expectedWorkspaceId?: string
  expectedWorkspaceRevision?: number
}
type Visibility = { includeHidden: boolean; includeIgnored: boolean }
type ScanEntry = WorkspaceEntry & { revision: string }
type ScanBudget = {
  visited: number
  bytes: number
  reasons: Set<WorkspacePartialReason>
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const pathCompare = (a: string, b: string) =>
  compare(a.toLowerCase(), b.toLowerCase()) || compare(a, b)
const publicEntry = ({
  revision: _revision,
  ...entry
}: ScanEntry): WorkspaceEntry => entry

export async function readBounded(
  handle: FileHandle,
  limit: number,
  signal?: AbortSignal,
) {
  const buffer = Buffer.alloc(limit + 1)
  let length = 0
  while (length < buffer.length) {
    signal?.throwIfAborted()
    const { bytesRead } = await handle.read(
      buffer,
      length,
      Math.min(64 * 1024, buffer.length - length),
      length,
    )
    if (!bytesRead) break
    length += bytesRead
  }
  return buffer.subarray(0, length)
}
async function verifiedTemporaryRevision(
  handle: FileHandle,
  owned: OwnedTemporary,
  bytes: Buffer,
) {
  const before = await handle.stat({ bigint: true })
  const candidate = { ...owned, revision: fileRevision(before) }
  if (
    identity(before) !== owned.identity ||
    !(await temporaryMatches(candidate))
  )
    return null
  const actual = await readBounded(handle, bytes.length)
  if (
    !actual.equals(bytes) ||
    fileRevision(await handle.stat({ bigint: true })) !== candidate.revision ||
    !(await temporaryMatches(candidate))
  )
    return null
  return candidate.revision
}
function decode(
  path: string,
  bytes: Buffer,
  info: Awaited<ReturnType<FileHandle['stat']>> & { size: bigint | number },
  revision: string,
): WorkspaceText {
  const size = Number(info.size)
  const base: WorkspaceText = {
    path,
    text: null,
    contentHash:
      bytes.length > WORKSPACE_LIMITS.previewBytes ? null : hash(bytes),
    fileRevision: revision,
    sizeBytes: size,
    modifiedAt: info.mtime.toISOString(),
    encoding: 'utf8',
    lineEnding: null,
    readOnlyReason: null,
    truncated: bytes.length > WORKSPACE_LIMITS.previewBytes,
  }
  if (base.truncated)
    return { ...base, encoding: 'unsupported', readOnlyReason: 'tooLarge' }
  if (bytes.includes(0))
    return { ...base, encoding: 'binary', readOnlyReason: 'binary' }
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bom ? bytes.subarray(3) : bytes,
    )
  } catch {
    return {
      ...base,
      encoding: 'unsupported',
      readOnlyReason: 'unsupportedEncoding',
    }
  }
  const crlf = text.includes('\r\n'),
    lf = /(?<!\r)\n/.test(text),
    loneCr = /\r(?!\n)/.test(text)
  const lineEnding =
    loneCr || (crlf && lf) ? 'mixed' : crlf ? 'crlf' : lf ? 'lf' : 'none'
  return {
    ...base,
    text: text.replaceAll('\r\n', '\n'),
    encoding: bom ? 'utf8Bom' : 'utf8',
    lineEnding,
    readOnlyReason:
      size > WORKSPACE_LIMITS.editBytes
        ? 'tooLarge'
        : (Number(info.mode) & 0o222) === 0
          ? 'permissionDenied'
          : lineEnding === 'mixed'
            ? 'mixedLineEndings'
            : null,
  }
}

export class WorkspaceFiles {
  readonly targets: WorkspaceTargets
  readonly watches: WorkspaceWatches
  readonly fileQueues = new KeyedQueue()
  private readonly operations = new WorkspaceOperations()
  private closing?: Promise<void>
  constructor(
    db: DatabaseSync,
    readonly hooks: FileHooks = {},
  ) {
    this.targets = new WorkspaceTargets(db, this.operations)
    this.watches = new WorkspaceWatches(this)
  }
  get diagnostics() {
    return {
      operations: this.operations.size,
      fileQueues: this.fileQueues.size,
      mutationQueues: this.targets.mutations.size,
      ...this.watches.diagnostics,
    }
  }
  operation<T>(
    signal: AbortSignal | undefined,
    action: (signal: AbortSignal) => Promise<T>,
  ) {
    return this.operations.operation(signal, action).catch((error) => {
      throw filesystemError(error)
    })
  }
  resolve(
    target: WorkspaceTarget,
    expected: Expected = {},
    signal?: AbortSignal,
  ) {
    return this.operation(signal, async (signal) => {
      const workspace = await this.targets.resolve(target, signal)
      this.targets.checkExpected(workspace, expected)
      return publicWorkspace(workspace)
    })
  }
  private async source(
    workspace: WorkspaceResolution,
    path: string,
    signal: AbortSignal,
  ) {
    const chain = await WorkspacePath.open(
      workspace.cwd,
      workspace.rootIdentity,
      path,
      false,
      signal,
      this.hooks,
    )
    try {
      const { handle, info } = await chain.openFile()
      try {
        await this.hooks.beforeRead?.(handle)
        const bytes = await readBounded(
          handle,
          WORKSPACE_LIMITS.previewBytes,
          signal,
        )
        const after = await handle.stat({ bigint: true })
        if (
          fileRevision(info) !== fileRevision(after) ||
          fileRevision(await lstat(chain.leaf, { bigint: true })) !==
            fileRevision(info)
        )
          throw new WorkspaceError(
            'stale_read',
            409,
            'File changed during read',
            publicWorkspace(workspace),
          )
        await chain.verify()
        return {
          file: decode(path, bytes, info, fileRevision(info)),
          bytes,
          info,
        }
      } finally {
        await handle.close()
      }
    } finally {
      await chain.close()
    }
  }
  read(
    target: WorkspaceTarget,
    path: string,
    expected: Expected = {},
    signal?: AbortSignal,
  ) {
    relativePath(path)
    return this.operation(signal, async (signal) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const workspace = await this.targets.resolve(target, signal)
        this.targets.checkExpected(workspace, expected)
        try {
          const source = await this.source(workspace, path, signal)
          const current = await this.targets.resolve(target, signal)
          this.targets.checkExpected(current, {
            expectedWorkspaceId: workspace.workspaceId,
            expectedWorkspaceRevision: workspace.workspaceRevision,
          })
          return { workspace: publicWorkspace(current), file: source.file }
        } catch (error) {
          if (!(
            error instanceof WorkspaceError &&
            error.code === 'stale_read' &&
            attempt === 0
          ))
            throw error
        }
      }
      throw new WorkspaceError('stale_read', 409, 'File changed during read')
    })
  }
  private async ignored(
    workspace: WorkspaceResolution,
    entries: ScanEntry[],
    signal: AbortSignal,
  ) {
    if (!workspace.gitDirectory || !entries.length) return
    const result = await runGit(
      workspace.cwd,
      ['check-ignore', '--no-index', '-z', '--stdin'],
      false,
      {
        stdin: entries.map((entry) => entry.path).join('\0') + '\0',
        signal,
        readOnly: true,
        maxOutputBytes: 2 * 1024 * 1024,
      },
    ).catch(() => {
      throw new WorkspaceError(
        'unavailable',
        503,
        'Git ignore rules are unavailable',
        publicWorkspace(workspace),
      )
    })
    if (result.code !== 0 && result.code !== 1)
      throw new WorkspaceError(
        'unavailable',
        503,
        'Git ignore rules are unavailable',
        publicWorkspace(workspace),
      )
    const ignored = new Set(result.stdout.split('\0'))
    for (const entry of entries) entry.ignored = ignored.has(entry.path)
  }
  private async scan(
    workspace: WorkspaceResolution,
    path: string,
    flags: Visibility,
    budget: ScanBudget,
    signal: AbortSignal,
  ) {
    const chain = await WorkspacePath.open(
      workspace.cwd,
      workspace.rootIdentity,
      path,
      true,
      signal,
      this.hooks,
    )
    const entries: ScanEntry[] = []
    let batch: ScanEntry[] = []
    const flush = async () => {
      try {
        await this.ignored(workspace, batch, signal)
        entries.push(
          ...batch.filter((entry) => flags.includeIgnored || !entry.ignored),
        )
      } catch (error) {
        if (signal.aborted) budget.reasons.add('timeout')
        else throw error
      }
      batch = []
    }
    try {
      const directoryRevision = fileRevision(
        await chain.parent.stat({ bigint: true }),
      )
      const dir = await opendir(descriptorPath(chain.parent))
      try {
        for await (const child of dir) {
          if (signal.aborted) {
            budget.reasons.add('timeout')
            break
          }
          if (++budget.visited > WORKSPACE_LIMITS.scan) {
            budget.reasons.add('scan_limit')
            break
          }
          if (
            child.name.toLowerCase() === '.git' ||
            ownedTemporary(child.name) ||
            (!flags.includeHidden && child.name.startsWith('.'))
          )
            continue
          const relative = path ? `${path}/${child.name}` : child.name
          try {
            relativePath(relative)
          } catch {
            continue
          }
          try {
            const info = await lstat(descriptorPath(chain.parent, child.name), {
              bigint: true,
            })
            const type = info.isDirectory()
              ? 'directory'
              : info.isSymbolicLink()
                ? 'symlink'
                : info.isFile()
                  ? 'file'
                  : 'other'
            const entry: ScanEntry = {
              path: relative,
              name: child.name,
              type,
              sizeBytes: type === 'symlink' ? null : Number(info.size),
              modifiedAt: type === 'symlink' ? null : info.mtime.toISOString(),
              ignored: false,
              revision: fileRevision(info),
            }
            budget.bytes += Buffer.byteLength(JSON.stringify(entry))
            if (budget.bytes > WORKSPACE_LIMITS.metadataBytes) {
              budget.reasons.add('metadata_limit')
              break
            }
            batch.push(entry)
            if (batch.length >= 256) await flush()
          } catch (error) {
            if (error instanceof WorkspaceError) throw error
            budget.reasons.add(
              (error as NodeJS.ErrnoException).code === 'ENOENT'
                ? 'race'
                : 'unreadable',
            )
          }
        }
      } finally {
        await dir.close().catch(() => {})
      }
      if (!signal.aborted) await flush()
      else budget.reasons.add('timeout')
      await chain.verify()
      if (
        fileRevision(await chain.parent.stat({ bigint: true })) !==
        directoryRevision
      )
        budget.reasons.add('race')
      return entries
    } finally {
      await chain.close()
    }
  }
  list(
    target: WorkspaceTarget,
    options: Visibility & Expected & { path: string; cursor?: string },
    signal?: AbortSignal,
  ) {
    relativePath(options.path, true)
    return this.operation(signal, async (signal) => {
      const workspace = await this.targets.resolve(target, signal)
      this.targets.checkExpected(workspace, options)
      const budget: ScanBudget = { visited: 0, bytes: 0, reasons: new Set() }
      const entries = await this.scan(
        workspace,
        options.path,
        options,
        budget,
        signal,
      )
      entries.sort(
        (a, b) =>
          Number(b.type === 'directory') - Number(a.type === 'directory') ||
          pathCompare(a.name, b.name) ||
          compare(a.path, b.path),
      )
      const binding = {
        version: 1,
        workspaceId: workspace.workspaceId,
        workspaceRevision: workspace.workspaceRevision,
        path: options.path,
        includeHidden: options.includeHidden,
        includeIgnored: options.includeIgnored,
        fingerprint: hash(JSON.stringify(entries)),
      }
      let offset = 0
      if (options.cursor) {
        try {
          const { offset: position, ...rest } = JSON.parse(
            Buffer.from(options.cursor, 'base64url').toString('utf8'),
          )
          if (
            JSON.stringify(rest) !== JSON.stringify(binding) ||
            !Number.isSafeInteger(position) ||
            position < 0 ||
            position >= entries.length
          )
            throw new Error('stale')
          offset = position
        } catch {
          throw new WorkspaceError(
            'conflict',
            409,
            'Directory listing changed',
            publicWorkspace(workspace),
            'listing_changed',
          )
        }
      }
      if (!signal.aborted) {
        try {
          this.targets.checkExpected(
            await this.targets.resolve(target, signal),
            {
              expectedWorkspaceId: workspace.workspaceId,
              expectedWorkspaceRevision: workspace.workspaceRevision,
            },
          )
        } catch (error) {
          if (!signal.aborted || error instanceof WorkspaceError) throw error
          budget.reasons.add('timeout')
        }
      }
      return {
        workspace: publicWorkspace(workspace),
        entries: entries
          .slice(offset, offset + WORKSPACE_LIMITS.page)
          .map(publicEntry),
        nextCursor:
          offset + WORKSPACE_LIMITS.page < entries.length
            ? Buffer.from(
                JSON.stringify({
                  ...binding,
                  offset: offset + WORKSPACE_LIMITS.page,
                }),
              ).toString('base64url')
            : null,
        truncated: budget.reasons.size > 0,
        partialReasons: [...budget.reasons],
      }
    })
  }
  search(
    target: WorkspaceTarget,
    options: Visibility & Expected & { query: string; limit: number },
    signal?: AbortSignal,
  ) {
    return this.operation(signal, async (signal) => {
      const workspace = await this.targets.resolve(target, signal)
      this.targets.checkExpected(workspace, options)
      const budget: ScanBudget = { visited: 0, bytes: 0, reasons: new Set() }
      const matches: Array<WorkspaceEntry & { score: number }> = []
      const queue = ['']
      const query = options.query.toLowerCase()
      const order = (
        a: (typeof matches)[number],
        b: (typeof matches)[number],
      ) => b.score - a.score || pathCompare(a.path, b.path)
      while (
        queue.length &&
        budget.visited < WORKSPACE_LIMITS.scan &&
        budget.bytes < WORKSPACE_LIMITS.metadataBytes
      ) {
        if (signal.aborted) {
          budget.reasons.add('timeout')
          break
        }
        const path = queue.shift()!
        let entries: ScanEntry[]
        try {
          entries = await this.scan(workspace, path, options, budget, signal)
        } catch (error) {
          if (
            path === '' ||
            (error instanceof WorkspaceError && error.code === 'unavailable')
          )
            throw error
          budget.reasons.add('unreadable')
          continue
        }
        for (const entry of entries) {
          if (entry.type === 'directory') {
            if (queue.length < WORKSPACE_LIMITS.watchDirectories)
              queue.push(entry.path)
            else budget.reasons.add('scan_limit')
          }
          const score = searchScore(entry.name, entry.path, query)
          if (score === null) continue
          matches.push({ ...publicEntry(entry), score })
          matches.sort(order)
          if (matches.length > options.limit) matches.pop()
        }
      }
      if (queue.length && !signal.aborted)
        budget.reasons.add(
          budget.bytes >= WORKSPACE_LIMITS.metadataBytes
            ? 'metadata_limit'
            : 'scan_limit',
        )
      if (!signal.aborted) {
        try {
          this.targets.checkExpected(
            await this.targets.resolve(target, signal),
            {
              expectedWorkspaceId: workspace.workspaceId,
              expectedWorkspaceRevision: workspace.workspaceRevision,
            },
          )
        } catch (error) {
          if (!signal.aborted || error instanceof WorkspaceError) throw error
          budget.reasons.add('timeout')
        }
      }
      return {
        workspace: publicWorkspace(workspace),
        matches,
        truncated: budget.reasons.size > 0,
        partialReasons: [...budget.reasons],
      }
    })
  }
  save(input: WorkspaceSave, signal?: AbortSignal) {
    relativePath(input.path)
    if (/[\0\r]/.test(input.text))
      throw new WorkspaceError(
        'invalid_path',
        400,
        'Submitted text must use LF and contain no NUL',
      )
    return this.operation(signal, async (signal) => {
      const workspace = await this.targets.resolve(input.target, signal)
      this.targets.checkExpected(workspace, input)
      return this.fileQueues.run(
        join(workspace.cwd, input.path),
        async () => {
          let chain: WorkspacePath | undefined,
            temporary: FileHandle | undefined,
            temporaryPath: string | undefined
          let published = false
          let ownedPath: string | undefined
          let ownership: OwnedTemporary | undefined
          try {
            const source = await this.source(workspace, input.path, signal)
            this.compareSource(workspace, input, source.file)
            if (source.file.readOnlyReason)
              throw new WorkspaceError(
                'read_only',
                403,
                'File is read-only',
                publicWorkspace(workspace),
                undefined,
                source.file,
              )
            const text =
              source.file.lineEnding === 'crlf'
                ? input.text.replaceAll('\n', '\r\n')
                : input.text
            const bytes = Buffer.from(
              (source.file.encoding === 'utf8Bom' ? '\ufeff' : '') + text,
            )
            if (bytes.length > WORKSPACE_LIMITS.editBytes)
              throw new WorkspaceError(
                'limit_exceeded',
                413,
                'Editable file limit exceeded',
                publicWorkspace(workspace),
              )
            chain = await WorkspacePath.open(
              workspace.cwd,
              workspace.rootIdentity,
              input.path,
              false,
              signal,
              this.hooks,
            )
            const parentInfo = await chain.parent.stat({ bigint: true })
            if (!(Number(parentInfo.mode) & 0o222))
              throw new WorkspaceError(
                'read_only',
                403,
                'Parent directory is read-only',
                publicWorkspace(workspace),
              )
            await chain.verify()
            signal.throwIfAborted()
            temporaryPath = descriptorPath(
              chain.parent,
              `.forge-save-${randomUUID()}`,
            )
            temporary = await open(
              temporaryPath,
              constants.O_RDWR |
                constants.O_CREAT |
                constants.O_EXCL |
                constants.O_NOFOLLOW,
              Number(source.info.mode) & 0o7777,
            )
            ownedPath = join(
              workspace.cwd,
              dirname(input.path),
              basename(temporaryPath),
            )
            const created = await temporary.stat({ bigint: true })
            ownership = {
              path: temporaryPath,
              identity: identity(created),
              revision: null,
            }
            this.targets.temporaryPaths.set(ownedPath, ownership)
            ownership.revision = await verifiedTemporaryRevision(
              temporary,
              ownership,
              Buffer.alloc(0),
            )
            let written = 0
            const write = async (length = bytes.length) => {
              if (!(await temporaryMatches(ownership!)))
                throw new WorkspaceError(
                  'conflict',
                  409,
                  'Staged file changed',
                  publicWorkspace(workspace),
                  'replaced',
                )
              const end = Math.min(bytes.length, written + length)
              try {
                while (written < end) {
                  signal.throwIfAborted()
                  const { bytesWritten } = await temporary!.write(
                    bytes,
                    written,
                    end - written,
                    written,
                  )
                  if (!bytesWritten)
                    throw new Error('Temporary write made no progress')
                  written += bytesWritten
                }
              } finally {
                // Trust only the exact bytes reported by completed writes.
                ownership!.revision = await verifiedTemporaryRevision(
                  temporary!,
                  ownership!,
                  bytes.subarray(0, written),
                ).catch(() => null)
              }
            }
            if (this.hooks.writeTemporary)
              await this.hooks.writeTemporary(write)
            else await write()
            if (written !== bytes.length)
              throw new Error('Temporary write is incomplete')
            if (!(await temporaryMatches(ownership)))
              throw new WorkspaceError(
                'conflict',
                409,
                'Staged file changed',
                publicWorkspace(workspace),
                'replaced',
              )
            await temporary.chmod(Number(source.info.mode) & 0o7777)
            ownership.revision = await verifiedTemporaryRevision(
              temporary,
              ownership,
              bytes,
            )
            if (!ownership.revision)
              throw new WorkspaceError(
                'conflict',
                409,
                'Staged file changed',
                publicWorkspace(workspace),
                'replaced',
              )
            signal.throwIfAborted()
            if (this.hooks.flushTemporary)
              await this.hooks.flushTemporary(temporary)
            else await temporary.sync()
            const stagedIdentity = ownership.identity
            await this.hooks.staged?.(input.path)
            signal.throwIfAborted()
            return await this.targets.mutations.run(
              workspace.gateKey,
              async () => {
                const current = await this.targets.resolve(input.target, signal)
                this.targets.checkExpected(current, input)
                await chain!.verify()
                if (
                  identity(await chain!.parent.stat({ bigint: true })) !==
                  identity(parentInfo)
                )
                  throw new WorkspaceError(
                    'conflict',
                    409,
                    'Parent directory changed',
                    publicWorkspace(current),
                    'replaced',
                  )
                const fresh = await this.source(current, input.path, signal)
                this.compareSource(current, input, fresh.file)
                if (fresh.file.readOnlyReason)
                  throw new WorkspaceError(
                    'read_only',
                    403,
                    'File is read-only',
                    publicWorkspace(current),
                  )
                await chain!.verify()
                signal.throwIfAborted()
                if (!(await temporaryMatches(ownership!)))
                  throw new WorkspaceError(
                    'conflict',
                    409,
                    'Staged file changed',
                    publicWorkspace(current),
                    'replaced',
                  )
                signal.throwIfAborted()
                if (this.hooks.renameTemporary)
                  await this.hooks.renameTemporary(temporaryPath!, chain!.leaf)
                else await rename(temporaryPath!, chain!.leaf)
                published = true
                temporaryPath = undefined
                await chain!.parent.sync()
                await this.hooks.afterPublish?.()
                const result = await this.source(current, input.path, signal)
                const resolved = await this.targets.resolve(
                  input.target,
                  signal,
                )
                this.targets.checkExpected(resolved, input)
                if (
                  result.file.contentHash !== hash(bytes) ||
                  identity(result.info) !== stagedIdentity
                )
                  throw new Error('Published file changed')
                this.watches.invalidate(current.workspaceId, [input.path])
                return {
                  workspace: publicWorkspace(resolved),
                  file: result.file,
                }
              },
              signal,
            )
          } catch (error) {
            if (published)
              throw new WorkspaceError(
                'publication_uncertain',
                503,
                'File publication may have happened; reload before saving',
                publicWorkspace(workspace),
                undefined,
                undefined,
                true,
              )
            if (
              (error as NodeJS.ErrnoException).code === 'ENOENT' ||
              (error instanceof WorkspaceError &&
                error.code === 'file_not_found')
            )
              throw new WorkspaceError(
                'conflict',
                409,
                'File was deleted',
                publicWorkspace(workspace),
                'deleted',
              )
            if (
              error instanceof WorkspaceError &&
              ['prohibited_path', 'stale_read'].includes(error.code)
            )
              throw new WorkspaceError(
                'conflict',
                409,
                'File or parent changed',
                publicWorkspace(workspace),
                error.reason ?? 'replaced',
              )
            if (error instanceof WorkspaceError)
              error.workspace ??= publicWorkspace(workspace)
            throw error
          } finally {
            if (ownership && temporaryPath) {
              if (await temporaryMatches(ownership))
                await unlink(temporaryPath).catch(() => {})
            }
            await temporary?.close().catch(() => {})
            await chain?.close()
            if (ownedPath) this.targets.temporaryPaths.delete(ownedPath)
          }
        },
        signal,
      )
    })
  }
  private compareSource(
    workspace: WorkspaceResolution,
    expected: WorkspaceSave,
    source: WorkspaceText,
  ) {
    if (source.contentHash !== expected.expectedContentHash)
      throw new WorkspaceError(
        'conflict',
        409,
        'File content changed',
        publicWorkspace(workspace),
        'changed',
        source,
      )
    if (source.fileRevision !== expected.expectedFileRevision)
      throw new WorkspaceError(
        'conflict',
        409,
        'File was replaced or its metadata changed',
        publicWorkspace(workspace),
        'replaced',
        source,
      )
  }
  async media(
    target: WorkspaceTarget,
    path: string,
    request: Request,
    expected: Expected = {},
  ) {
    relativePath(path)
    const lease = this.operations.lease(request.signal, false)
    let chain: WorkspacePath | undefined, handle: FileHandle | undefined
    const readSignal = AbortSignal.any([
      lease.signal,
      AbortSignal.timeout(WORKSPACE_LIMITS.timeoutMs),
    ])
    const cleanup = async () => {
      await handle?.close().catch(() => {})
      await chain?.close()
      lease.release()
    }
    try {
      const workspace = await this.targets.resolve(target, readSignal)
      this.targets.checkExpected(workspace, expected)
      chain = await WorkspacePath.open(
        workspace.cwd,
        workspace.rootIdentity,
        path,
        false,
        readSignal,
        this.hooks,
      )
      const opened = await chain.openFile()
      handle = opened.handle
      const current = await this.targets.resolve(target, readSignal)
      this.targets.checkExpected(current, {
        expectedWorkspaceId: workspace.workspaceId,
        expectedWorkspaceRevision: workspace.workspaceRevision,
      })
      const mime =
        MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
      const inline =
        /^(image\/(png|jpeg|gif|webp)|audio\/(mpeg|wav)|video\/(mp4|webm))$/.test(
          mime,
        )
      const response = rangeResponse(request, {
        path: '',
        size: Number(opened.info.size),
        mime: inline ? mime : 'application/octet-stream',
        filename: basename(path),
        etag: fileRevision(opened.info),
        handle,
        cleanup,
        signal: lease.signal,
        forceDownload: !inline,
      })
      response.headers.set('X-Workspace-Id', workspace.workspaceId)
      response.headers.set(
        'X-Workspace-Revision',
        String(workspace.workspaceRevision),
      )
      response.headers.set('X-Workspace-Media', inline ? 'inline' : 'download')
      response.headers.set('X-Content-Type-Options', 'nosniff')
      response.headers.set(
        'Content-Security-Policy',
        "sandbox; default-src 'none'",
      )
      if (!response.body) await cleanup()
      return response
    } catch (error) {
      await cleanup()
      throw filesystemError(error)
    }
  }
  close() {
    if (!this.closing) {
      const operations = this.operations.close()
      this.closing = (async () => {
        await this.watches.close()
        await this.targets.close()
        await operations
      })()
    }
    return this.closing
  }
}

export function searchScore(
  nameInput: string,
  pathInput: string,
  query: string,
): number | null {
  const name = nameInput.toLowerCase(),
    path = pathInput.toLowerCase()
  if (name === query) return 10_000
  if (name.startsWith(query)) return 8000 - Buffer.byteLength(name)
  let index = name.indexOf(query)
  if (index >= 0)
    return (
      6000 - Buffer.byteLength(name.slice(0, index)) - Buffer.byteLength(name)
    )
  index = path.indexOf(query)
  if (index >= 0)
    return (
      4000 - Buffer.byteLength(path.slice(0, index)) - Buffer.byteLength(path)
    )
  const wanted = [...query]
  let matched = 0,
    gaps = 0
  for (const character of path) {
    if (character === wanted[matched]) {
      if (++matched === wanted.length)
        return 2000 - gaps - Buffer.byteLength(path)
    } else gaps++
  }
  return null
}
