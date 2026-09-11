import { constants, realpathSync, statSync } from 'node:fs'
import { open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import type { HarnessAccount } from '@forge/protocol/accounts'
import type { HarnessConfig } from '@forge/protocol/config'
import type { ConfirmedNativeBinding, HarnessSession } from '../types.js'
import { accountEnv } from '../../accounts/store.js'
import {
  bytes,
  check,
  commandSchema,
  fail,
  freeze,
  id,
  MiB,
  physicalWork,
  PublicationBudget,
  reservePhysical,
  snapshot,
  stateSchema,
  text,
  waitOwned,
  type PiLimits,
} from './wire.js'
import { decodeEntry, type PiNativeRecord } from './normalize.js'
import {
  persistWireImages,
  type PiHistoryOwner,
  type PiLiveOwner,
  type PersistPiImage,
} from './input.js'

export type ConfirmedPiBinding = Readonly<
  ConfirmedNativeBinding & { sessionFile: string }
>
export type PiResumeTarget = Readonly<{ binding: ConfirmedPiBinding }>
export type PiNativeLaunch = Readonly<{
  credentials: 'native-configured-sources'
  providerId: string
  account: Pick<
    HarnessAccount,
    | 'id'
    | 'harnessKey'
    | 'kind'
    | 'adapterKind'
    | 'disabledAt'
    | 'homePath'
    | 'config'
  > | null
  harness: HarnessConfig
  canonicalCwd: string
  accountHome: string
  selectedEnvOverrides: Readonly<Record<string, string | undefined>>
}>
export type PiLaunchOptions = {
  providerId: string
  launch: PiNativeLaunch
  executable: string
  args: string[]
  env: Readonly<Record<string, string | undefined>>
}
export type PiStateSnapshot = Readonly<
  z.infer<typeof stateSchema> & {
    bindingValidation: 'confirmed'
    fileObserved: boolean
  }
>
export type PiCatalogSnapshot = Readonly<{
  models: Array<z.infer<typeof stateSchema>['model'] & { catalogId: string }>
  thinkingLevels: string[]
  commands: z.infer<typeof commandSchema>[]
  startupNotices: string[]
  unsupported: string[]
}>
export type PiHistoryCursor = {
  sessionId: string
  sessionFile: string
  dev: string
  ino: string
  offset: number
  prefixDigest: string
}
export type PiHistoryPage = {
  records: PiNativeRecord[]
  end: PiHistoryCursor
  next: PiHistoryCursor | null
  complete: boolean
}
export type PersistPiRecord = (
  owner: PiLiveOwner,
  binding: ConfirmedPiBinding,
  record: PiNativeRecord,
  signal: AbortSignal,
) => Promise<void>
export type CommitPiHistoryPage = (
  owner: PiHistoryOwner,
  binding: ConfirmedPiBinding,
  input: { expected: PiHistoryCursor | null; page: PiHistoryPage },
  signal: AbortSignal,
) => Promise<void>
export type PersistPiSnapshot = (
  owner: PiLiveOwner,
  snapshot:
    | { kind: 'state'; value: PiStateSnapshot }
    | { kind: 'catalog'; value: PiCatalogSnapshot },
  signal: AbortSignal,
) => Promise<void>
export type PiHistoryReader = {
  readonly owner: PiHistoryOwner
  read(
    cursor: PiHistoryCursor | null,
    limits?: { maxEntries?: number; maxBytes?: number },
  ): Promise<PiHistoryPage>
  close(): void
}
export const bindingSchema = z.strictObject({
  provider: id,
  accountId: id.nullable(),
  cwd: text(16 * 1024).min(1),
  providerSessionId: id,
  sessionFile: text(16 * 1024).min(1),
})
const headerSchema = z.strictObject({
  type: z.literal('session'),
  version: z.literal(3),
  id,
  timestamp: z.string().datetime({ offset: true }),
  cwd: text(16 * 1024).min(1),
  parentSession: text(16 * 1024).optional(),
})
const forbidden = new Set([
  '--mode',
  '--session-dir',
  '--session',
  '--continue',
  '-c',
  '--resume',
  '-r',
  '--session-id',
  '--fork',
  '--no-session',
  '--print',
  '-p',
  '--export',
  '--help',
  '-h',
  '--version',
  '-v',
  '--api-key',
  '--approve',
  '--offline',
])
const booleans = new Set([
  '--no-extensions',
  '-ne',
  '--no-tools',
  '--no-skills',
  '-ns',
  '--no-prompt-templates',
  '-np',
  '--no-themes',
  '--no-approve',
  '--verbose',
])
const valued = new Set([
  '--extension',
  '-e',
  '--skill',
  '--prompt-template',
  '--theme',
  '--system-prompt',
  '--append-system-prompt',
  '--tools',
])
export function nativeArguments(
  configured: string[],
  config?: HarnessAccount['config'],
): string[] {
  if (configured.length > 256) fail('PI_ARGUMENT_LIMIT')
  const output: string[] = []
  const selected: Record<string, string> = {}
  for (let i = 0; i < configured.length; i++) {
    const original = configured[i]!
    const equals = original.indexOf('=')
    const flag = equals < 0 ? original : original.slice(0, equals)
    if (forbidden.has(flag) || !flag.startsWith('-') || flag === '--')
      fail('PI_ARGUMENT_UNSUPPORTED')
    if (['--provider', '--model', '-m', '--thinking'].includes(flag)) {
      const canonical = flag === '-m' ? '--model' : flag
      if (selected[canonical] !== undefined) fail('PI_ARGUMENT_CONFLICT')
      const value = equals < 0 ? configured[++i] : original.slice(equals + 1)
      if (!value || value.startsWith('-') || value.startsWith('@'))
        fail('PI_ARGUMENT_INVALID')
      selected[canonical] = value
    } else if (booleans.has(flag)) {
      if (equals >= 0) fail('PI_ARGUMENT_INVALID')
      output.push(flag)
    } else {
      if (!valued.has(flag) && !/^--[a-zA-Z][a-zA-Z0-9_-]*$/.test(flag))
        fail('PI_ARGUMENT_UNSUPPORTED')
      if (equals >= 0) {
        output.push(original)
        continue
      }
      const value = configured[i + 1]
      if (value === undefined || value.startsWith('-')) {
        if (valued.has(flag)) fail('PI_ARGUMENT_INVALID')
        output.push(flag)
      } else {
        if (value.startsWith('@')) fail('PI_ARGUMENT_INVALID')
        output.push(flag, value)
        i++
      }
    }
  }
  for (const [flag, value] of [
    ['--provider', config?.provider],
    ['--model', config?.model],
    ['--thinking', config?.thinking],
  ])
    if (value !== undefined && selected[flag!] === undefined)
      selected[flag!] = value
  for (const [key, value] of Object.entries(selected)) output.push(key, value)
  return output
}
function sameMap(
  a: Readonly<Record<string, string | undefined>>,
  b: Readonly<Record<string, string | undefined>>,
) {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  return (
    ak.length === bk.length &&
    ak.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
  )
}
function executablePath(command: string, env: NodeJS.ProcessEnv) {
  if (isAbsolute(command)) return realpathSync(command)
  if (command.includes(sep)) fail('PI_EXECUTABLE_INVALID')
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue
    try {
      const path = realpathSync(join(directory, command))
      if (statSync(path).isFile()) return path
    } catch {
      /* Search captured PATH only. */
    }
  }
  return fail('PI_EXECUTABLE_MISSING')
}
export type CapturedLaunch = ReturnType<typeof captureLaunch>
export function captureLaunch(input: PiLaunchOptions) {
  if (!input.launch) fail('PI_ACCOUNT_LAUNCH_AUTHORITY_REQUIRED')
  const selected = snapshot(input)
  if (selected.launch.credentials !== 'native-configured-sources')
    fail('PI_ACCOUNT_AUTH_SOURCE_UNSUPPORTED')
  const inherited = snapshot({ ...process.env })
  const authority = selected.launch
  if (!Object.hasOwn(authority, 'account') || authority.account === undefined)
    fail('PI_ACCOUNT_LAUNCH_SCOPE_MISMATCH')
  const explicit = {
    ...authority.harness.env,
    ...authority.selectedEnvOverrides,
  }
  if (
    authority.providerId !== selected.providerId ||
    !authority.harness.enabled ||
    authority.harness.adapterKind !== 'native' ||
    !sameMap(selected.env, explicit) ||
    JSON.stringify(selected.args) !== JSON.stringify(authority.harness.args) ||
    !isAbsolute(selected.executable) ||
    !isAbsolute(authority.accountHome) ||
    !isAbsolute(authority.canonicalCwd)
  )
    fail('PI_ACCOUNT_LAUNCH_SCOPE_MISMATCH')
  const account = authority.account
  if (
    account &&
    (account.harnessKey !== selected.providerId ||
      account.kind !== 'pi' ||
      account.disabledAt !== null ||
      (account.adapterKind !== undefined && account.adapterKind !== 'native') ||
      account.homePath !== authority.accountHome)
  )
    fail('PI_ACCOUNT_LAUNCH_SCOPE_MISMATCH')
  if (!account && authority.accountHome !== join(homedir(), '.pi', 'agent'))
    fail('PI_ACCOUNT_LAUNCH_SCOPE_MISMATCH')
  const args = nativeArguments(selected.args, account?.config)
  const env = {
    ...inherited,
    ...explicit,
    ...accountEnv('pi', authority.accountHome),
  }
  if (
    args.length > 246 ||
    [authority.accountHome, authority.canonicalCwd, selected.executable].some(
      (path) => Buffer.byteLength(path) > 16 * 1024,
    )
  )
    fail('PI_ARGUMENT_LIMIT')
  if (
    Object.keys(env).length > 1024 ||
    bytes({ selected, inherited, env }) > 2 * MiB ||
    Object.values(env).some(
      (v) => v !== undefined && Buffer.byteLength(v) > 64 * 1024,
    )
  )
    fail('PI_ENVIRONMENT_LIMIT')
  // These values only redact diagnostics. They never filter child authentication.
  const secrets = [
    ...new Set(
      [
        ...Object.values(explicit),
        ...Object.entries(inherited)
          .filter(([key]) =>
            /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key),
          )
          .map(([, value]) => value),
      ].filter(
        (value): value is string =>
          typeof value === 'string' && value.length > 0,
      ),
    ),
  ]
  if (secrets.length > 128 || bytes(secrets) > MiB) fail('PI_REDACTION_LIMIT')
  const expectedExecutable = executablePath(authority.harness.command, env)
  if (realpathSync(selected.executable) !== expectedExecutable)
    fail('PI_ACCOUNT_LAUNCH_SCOPE_MISMATCH')
  return freeze({
    ...selected,
    args,
    inherited,
    env,
    executable: expectedExecutable,
    secrets,
    root: join(authority.accountHome, 'sessions'),
  })
}
export function authorize(
  launch: CapturedLaunch,
  sessionInput: HarnessSession,
  target?: PiResumeTarget,
): HarnessSession {
  const session = snapshot(sessionInput)
  const a = launch.launch
  if (
    !session.id ||
    session.provider !== launch.providerId ||
    (session.accountId ?? null) !== (a.account?.id ?? null) ||
    session.cwd !== a.canonicalCwd
  )
    fail('PI_ACCOUNT_LAUNCH_SCOPE_MISMATCH')
  if (target) {
    const b = bindingSchema.parse(target.binding)
    if (
      !a.account ||
      b.provider !== session.provider ||
      b.accountId !== (session.accountId ?? null) ||
      b.cwd !== session.cwd ||
      (session.binding &&
        (session.binding.provider !== b.provider ||
          session.binding.accountId !== b.accountId ||
          session.binding.cwd !== b.cwd ||
          session.binding.providerSessionId !== b.providerSessionId ||
          !('sessionFile' in session.binding) ||
          session.binding.sessionFile !== b.sessionFile))
    )
      fail('PI_RESUME_SCOPE_MISMATCH')
    confined(launch.root, b.sessionFile)
  }
  // Identity mismatch checks above precede filesystem access.
  if (
    realpathSync(session.cwd) !== session.cwd ||
    realpathSync(a.accountHome) !== a.accountHome
  )
    fail('PI_ACCOUNT_LAUNCH_SCOPE_MISMATCH')
  return session
}
export function environmentAtLaunch(launch: CapturedLaunch): NodeJS.ProcessEnv {
  const result = { ...launch.env }
  for (const key of Object.keys(process.env))
    if (!Object.hasOwn(result, key)) result[key] = undefined
  return result
}
export async function verifyVersion(
  executable: string,
  signal: AbortSignal,
  config: Readonly<PiLimits>,
) {
  return physicalWork('resume', signal, config.fileMs, async () => {
    let directory = dirname(executable)
    while (true) {
      check(signal)
      try {
        const file = await open(
          join(directory, 'package.json'),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        )
        let raw: string
        try {
          const metadata = await file.stat()
          if (!metadata.isFile() || metadata.size > 64 * 1024)
            fail('PI_PACKAGE_METADATA_LIMIT')
          const buffer = Buffer.alloc(64 * 1024 + 1)
          let length = 0
          while (length < buffer.length) {
            check(signal)
            const { bytesRead } = await file.read(
              buffer,
              length,
              buffer.length - length,
              length,
            )
            if (!bytesRead) break
            length += bytesRead
          }
          if (length > 64 * 1024) fail('PI_PACKAGE_METADATA_LIMIT')
          raw = new TextDecoder('utf8', { fatal: true }).decode(
            buffer.subarray(0, length),
          )
        } finally {
          await file.close()
        }
        const info = JSON.parse(raw) as { name?: string; version?: string }
        if (info.name === '@earendil-works/pi-coding-agent') {
          if (info.version !== '0.84.0') fail('PI_VERSION_UNSUPPORTED')
          return
        }
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') throw error
      }
      const parent = dirname(directory)
      if (parent === directory) fail('PI_PACKAGE_METADATA_MISSING')
      directory = parent
    }
  })
}
export function confined(root: string, path: string) {
  if (!isAbsolute(path) || resolve(path) !== path)
    fail('PI_SESSION_PATH_INVALID')
  const rel = relative(root, path)
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel))
    fail('PI_SESSION_OUTSIDE_ROOT')
}
export async function canonicalSessionPath(
  root: string,
  path: string,
  allowMissing: boolean,
) {
  confined(root, path)
  let ancestor = path
  while (true) {
    try {
      if ((await realpath(ancestor)) !== ancestor)
        fail('PI_SESSION_PATH_CHANGED')
      break
    } catch (error) {
      if (!allowMissing || (error as { code?: string }).code !== 'ENOENT')
        throw error
      ancestor = dirname(ancestor)
    }
  }
}
export function modelKey(provider: string, model: string) {
  return JSON.stringify([provider, model])
}
export function stateSnapshot(
  raw: unknown,
  observed: boolean,
): PiStateSnapshot {
  return freeze({
    ...stateSchema.parse(raw),
    bindingValidation: 'confirmed',
    fileObserved: observed,
  })
}
export function bindingFromState(
  session: HarnessSession,
  state: z.infer<typeof stateSchema>,
): ConfirmedPiBinding {
  return freeze(
    bindingSchema.parse({
      provider: session.provider,
      accountId: session.accountId ?? null,
      cwd: session.cwd,
      providerSessionId: state.sessionId,
      sessionFile: state.sessionFile,
    }),
  )
}
export function verifyStateBinding(
  binding: ConfirmedPiBinding,
  state: z.infer<typeof stateSchema>,
) {
  if (
    binding.providerSessionId !== state.sessionId ||
    binding.sessionFile !== state.sessionFile
  )
    fail('PI_RESUME_IDENTITY_CHANGED')
}
type FileIdentity = {
  dev: string
  ino: string
  size: number
  mtime: number
  ctime: number
}
function identity(s: Awaited<ReturnType<FileHandle['stat']>>): FileIdentity {
  if (!s.isFile() || s.size <= 0) fail('PI_SESSION_FILE_INVALID')
  return {
    dev: String(s.dev),
    ino: String(s.ino),
    size: Number(s.size),
    mtime: Number(s.mtimeMs),
    ctime: Number(s.ctimeMs),
  }
}
function sameIdentity(a: FileIdentity, b: FileIdentity) {
  return JSON.stringify(a) === JSON.stringify(b)
}
export async function* fileLines(
  file: FileHandle,
  end: number,
  signal: AbortSignal,
  lineLimit = 40 * MiB,
  firstLineLimit = lineLimit,
): AsyncGenerator<{ value: unknown; raw: Buffer; end: number }> {
  const releaseScan = reservePhysical('file', 64 * 1024)
  try {
    const chunk = Buffer.alloc(64 * 1024)
    const decoder = new TextDecoder('utf8', { fatal: true })
    let position = 0
    let start = 0
    let quoted = false
    let escaped = false
    let structureBytes = 0
    let scanned = createHash('sha256')
    while (position < end) {
      check(signal)
      const { bytesRead } = await file.read(
        chunk,
        0,
        Math.min(chunk.length, end - position),
        position,
      )
      check(signal)
      if (!bytesRead) fail('PI_SESSION_FILE_CHANGED')
      let offset = 0
      while (offset < bytesRead) {
        const limit = start === 0 ? firstLineLimit : lineLimit
        const newline = chunk.indexOf(10, offset)
        const stop =
          newline < 0 || newline >= bytesRead ? bytesRead : newline + 1
        scanned.update(chunk.subarray(offset, stop))
        for (let index = offset; index < stop; index++) {
          const byte = chunk[index]
          if (escaped) escaped = false
          else if (quoted && byte === 92) escaped = true
          else if (byte === 34) quoted = !quoted
          else if (
            !quoted &&
            (byte === 123 || byte === 91 || byte === 58 || byte === 44)
          )
            structureBytes += 512
        }
        if (stop === bytesRead && (newline < 0 || newline >= bytesRead)) break
        const next = position + newline + 1
        const length = next - start
        const scannedDigest = scanned.digest('hex')
        if (length - 1 > limit) fail('PI_HISTORY_LINE_LIMIT')
        // Raw bytes and parsed UTF-16 strings remain owned across the yield.
        const releaseLine = reservePhysical('file', 3 * length + structureBytes)
        try {
          const raw = Buffer.alloc(length)
          let read = 0
          while (read < length) {
            check(signal)
            const result = await file.read(
              raw,
              read,
              length - read,
              start + read,
            )
            check(signal)
            if (!result.bytesRead) fail('PI_SESSION_FILE_CHANGED')
            read += result.bytesRead
          }
          if (createHash('sha256').update(raw).digest('hex') !== scannedDigest)
            fail('PI_SESSION_FILE_CHANGED')
          // The temporary decoded string ends before any image callback starts.
          const releaseText = reservePhysical('file', 2 * length)
          let value: unknown
          try {
            value = JSON.parse(decoder.decode(raw))
          } finally {
            releaseText()
          }
          yield { value, raw, end: next }
        } finally {
          releaseLine()
        }
        start = next
        offset = newline + 1
        structureBytes = 0
        scanned = createHash('sha256')
        quoted = false
        escaped = false
      }
      position += bytesRead
      if (position - start > (start === 0 ? firstLineLimit : lineLimit))
        fail('PI_HISTORY_LINE_LIMIT')
    }
    if (start !== end) fail('PI_SESSION_PARTIAL_LINE')
  } finally {
    releaseScan()
  }
}
function validateHeader(value: unknown, binding: ConfirmedPiBinding) {
  const header = headerSchema.parse(value)
  if (header.id !== binding.providerSessionId || header.cwd !== binding.cwd)
    fail('PI_RESUME_IDENTITY_CHANGED')
  return header
}
export type ValidatedResume = {
  readonly file: FileHandle
  verify(): Promise<void>
  close(): Promise<void>
}
export async function validateResume(
  binding: ConfirmedPiBinding,
  root: string,
  signal: AbortSignal,
  config: Readonly<PiLimits>,
): Promise<ValidatedResume> {
  check(signal)
  const release = reservePhysical('resume')
  let transferred = false
  const actual = (async () => {
    await canonicalSessionPath(root, binding.sessionFile, false)
    check(signal)
    const file = await open(
      binding.sessionFile,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    )
    try {
      const original = identity(await file.stat())
      if (original.size > 64 * MiB) fail('PI_RESUME_FILE_LIMIT')
      const ids = new Set<string>()
      let idBytes = 0
      let headerDigest = ''
      let headerLength = 0
      for await (const line of fileLines(
        file,
        original.size,
        signal,
        40 * MiB,
        MiB,
      )) {
        if (!headerDigest) {
          if (line.end > MiB) fail('PI_SESSION_HEADER_LIMIT')
          validateHeader(line.value, binding)
          headerDigest = createHash('sha256').update(line.raw).digest('hex')
          headerLength = line.end
        } else {
          const entry = decodeEntry(line.value)
          if (
            ids.has(entry.id) ||
            (entry.parentId !== null && !ids.has(entry.parentId))
          )
            fail('PI_HISTORY_ANCESTRY')
          ids.add(entry.id)
          idBytes += Buffer.byteLength(entry.id) + 128
          if (ids.size > 100_000 || idBytes > 32 * MiB)
            fail('PI_RESUME_ANCESTRY_LIMIT')
        }
      }
      check(signal)
      let closed = false
      const held: ValidatedResume = {
        file,
        async verify() {
          check(signal)
          await canonicalSessionPath(root, binding.sessionFile, false)
          const current = identity(await file.stat())
          const atPath = identity(await stat(binding.sessionFile))
          if (
            !sameIdentity(current, original) ||
            !sameIdentity(atPath, original)
          )
            fail(
              'PI_RESUME_IDENTITY_CHANGED',
              'The native session file changed during startup. Pi may have rewritten an externally emptied file.',
            )
          const header = Buffer.alloc(headerLength)
          const result = await file.read(header, 0, header.length, 0)
          if (
            result.bytesRead !== headerLength ||
            createHash('sha256').update(header).digest('hex') !== headerDigest
          )
            fail('PI_RESUME_IDENTITY_CHANGED')
        },
        async close() {
          if (!closed) {
            closed = true
            try {
              await file.close()
            } finally {
              release()
            }
          }
        },
      }
      await held.verify()
      if (signal.aborted) {
        await held.close()
        check(signal)
      }
      transferred = true
      return held
    } catch (error) {
      await file.close()
      throw error
    }
  })().finally(() => {
    if (!transferred) release()
  })
  try {
    return await waitOwned(actual, signal, config.fileMs)
  } catch (error) {
    void actual.then(
      (held) => held.close(),
      () => {},
    )
    throw error
  }
}
export async function observeFreshFile(
  binding: ConfirmedPiBinding,
  root: string,
  signal: AbortSignal,
  config: Readonly<PiLimits>,
  reservationHeld = false,
): Promise<FileIdentity | null> {
  const inspect = async () => {
    await canonicalSessionPath(root, binding.sessionFile, true)
    let file: FileHandle
    try {
      file = await open(
        binding.sessionFile,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      )
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null
      throw error
    }
    try {
      const found = identity(await file.stat())
      for await (const line of fileLines(file, found.size, signal, MiB)) {
        validateHeader(line.value, binding)
        return found
      }
      return fail('PI_SESSION_HEADER_MISSING')
    } finally {
      await file.close()
    }
  }
  return reservationHeld
    ? inspect()
    : physicalWork('resume', signal, config.fileMs, inspect)
}
export function historyReader(
  launch: CapturedLaunch,
  sessionInput: HarnessSession,
  targetInput: PiResumeTarget,
  signal: AbortSignal,
  importId: string,
  config: Readonly<PiLimits>,
  persist: PersistPiImage,
  commit: CommitPiHistoryPage,
  releaseImport: () => void,
): PiHistoryReader {
  const target = snapshot(targetInput)
  const session = authorize(launch, sessionInput, target)
  const binding = freeze(bindingSchema.parse(target.binding))
  const owner = freeze({
    kind: 'history_import' as const,
    forgeSessionId: session.id,
    importOperationId: id.parse(importId),
  })
  const controller = new AbortController()
  let reading = false
  let ordinal = 0
  let closed = false
  let pendingEntry:
    | {
        record: PiNativeRecord
        digest: string
        release: () => void
      }
    | undefined
  const close = () => {
    if (closed) return
    closed = true
    controller.abort()
    pendingEntry?.release()
    pendingEntry = undefined
    clearTimeout(timer)
    signal.removeEventListener('abort', close)
    releaseImport()
  }
  const timer = setTimeout(close, config.importMs)
  signal.addEventListener('abort', close, { once: true })
  if (signal.aborted) close()
  const budget = new PublicationBudget(
    config.importPublications,
    config.importPublicationBytes,
  )
  const charge = (size: number) => PublicationBudget.charge(size, budget)
  return {
    owner,
    close,
    async read(cursorInput, requestedInput = {}) {
      if (reading) fail('PI_HISTORY_BUSY')
      check(controller.signal)
      reading = true
      try {
        const cursor = snapshot(cursorInput)
        const requested = snapshot(requestedInput)
        const maxEntries = requested.maxEntries ?? 128
        const maxBytes = requested.maxBytes ?? 8 * MiB
        if (
          !Number.isSafeInteger(maxEntries) ||
          maxEntries < 1 ||
          maxEntries > 128 ||
          !Number.isSafeInteger(maxBytes) ||
          maxBytes < 1 ||
          maxBytes > 8 * MiB
        )
          fail('PI_HISTORY_PAGE_LIMIT')
        return await physicalWork(
          'history',
          controller.signal,
          config.fileMs + config.sinkMs,
          async () => {
            await canonicalSessionPath(launch.root, binding.sessionFile, false)
            check(controller.signal)
            const file = await open(
              binding.sessionFile,
              constants.O_RDONLY | constants.O_NOFOLLOW,
            )
            try {
              const original = identity(await file.stat())
              if (
                cursor &&
                (cursor.sessionId !== binding.providerSessionId ||
                  cursor.sessionFile !== binding.sessionFile ||
                  cursor.dev !== original.dev ||
                  cursor.ino !== original.ino ||
                  !Number.isSafeInteger(cursor.offset) ||
                  cursor.offset < 0 ||
                  cursor.offset > original.size)
              )
                fail('PI_HISTORY_CURSOR_CHANGED')
              const hash = createHash('sha256')
              const ids = new Set<string>()
              let idBytes = 0
              const records: PiNativeRecord[] = []
              let total = 0
              let end = 0
              let digest = ''
              let header = false
              let matched = cursor === null
              for await (const line of fileLines(
                file,
                original.size,
                controller.signal,
                40 * MiB,
                MiB,
              )) {
                if (!header) {
                  if (line.end > MiB) fail('PI_SESSION_HEADER_LIMIT')
                  validateHeader(line.value, binding)
                  header = true
                  hash.update(line.raw)
                  end = line.end
                  digest = hash.copy().digest('hex')
                  if (cursor?.offset === end) {
                    if (digest !== cursor.prefixDigest)
                      fail('PI_HISTORY_CURSOR_CHANGED')
                    matched = true
                  }
                  continue
                }
                const decoded = decodeEntry(line.value, launch.secrets)
                if (
                  ids.has(decoded.id) ||
                  (decoded.parentId !== null && !ids.has(decoded.parentId))
                )
                  fail('PI_HISTORY_ANCESTRY')
                ids.add(decoded.id)
                idBytes += Buffer.byteLength(decoded.id) + 128
                if (ids.size > 100_000 || idBytes > 32 * MiB)
                  fail('PI_HISTORY_ANCESTRY_LIMIT')
                if (cursor && line.end <= cursor.offset) {
                  hash.update(line.raw)
                  end = line.end
                  digest = hash.copy().digest('hex')
                  if (end === cursor.offset) {
                    if (digest !== cursor.prefixDigest)
                      fail('PI_HISTORY_CURSOR_CHANGED')
                    matched = true
                  }
                  continue
                }
                if (!matched) fail('PI_HISTORY_CURSOR_CHANGED')
                if (records.length >= maxEntries) break
                const record = freeze({
                  source: {
                    kind: 'history' as const,
                    sessionId: binding.providerSessionId,
                    sessionFile: binding.sessionFile,
                    importOperationId: owner.importOperationId,
                    ordinal: ordinal + 1,
                    entryId: decoded.id,
                    parentId: decoded.parentId,
                  },
                  body: decoded.body,
                })
                const entryDigest = createHash('sha256')
                  .update(line.raw)
                  .digest('hex')
                if (
                  pendingEntry &&
                  (pendingEntry.digest !== entryDigest ||
                    pendingEntry.record.source.kind !== 'history' ||
                    pendingEntry.record.source.entryId !== decoded.id)
                )
                  fail('PI_HISTORY_CURSOR_CHANGED')
                const transformed =
                  pendingEntry?.record ??
                  (await persistWireImages(
                    record,
                    owner,
                    persist,
                    controller.signal,
                    config,
                    charge,
                  ))
                const size = bytes(transformed)
                if (size > maxBytes) fail('PI_HISTORY_ENTRY_LIMIT')
                if (total + size > maxBytes) {
                  pendingEntry ??= {
                    record: transformed,
                    digest: entryDigest,
                    release: reservePhysical('sink', size),
                  }
                  break
                }
                pendingEntry?.release()
                pendingEntry = undefined
                ordinal++
                total += size
                records.push(transformed)
                hash.update(line.raw)
                end = line.end
                digest = hash.copy().digest('hex')
              }
              if (!header || !matched) fail('PI_HISTORY_CURSOR_CHANGED')
              check(controller.signal)
              const current = identity(await file.stat())
              const atPath = identity(await stat(binding.sessionFile))
              if (
                !sameIdentity(current, original) ||
                !sameIdentity(atPath, original)
              )
                fail('PI_HISTORY_CURSOR_CHANGED')
              const endCursor = {
                sessionId: binding.providerSessionId,
                sessionFile: binding.sessionFile,
                dev: original.dev,
                ino: original.ino,
                offset: end,
                prefixDigest: digest,
              }
              const complete = end === original.size
              const page = freeze({
                records,
                end: endCursor,
                next: complete ? null : endCursor,
                complete,
              })
              for (const record of records) charge(bytes(record))
              const input = freeze({ expected: cursor, page })
              const envelope = {
                owner,
                binding,
                input: { ...input, page: { ...page, records: [] } },
              }
              charge(bytes(envelope))
              await physicalWork(
                'sink',
                controller.signal,
                config.sinkMs,
                () => commit(owner, binding, input, controller.signal),
                bytes({ owner, binding, input }),
              )
              check(controller.signal)
              return page
            } finally {
              await file.close()
            }
          },
        )
      } catch (error) {
        close()
        throw error
      } finally {
        reading = false
      }
    },
  }
}
