import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, relative, isAbsolute, sep } from 'node:path'
import { z } from 'zod'
import * as acp from '@zed-industries/agent-client-protocol'
import type { ClientHandlers } from './client.js'
import { isUserQuestion, type QuestionManager } from './questions.js'

const permissionRequest = z.object({
  options: z.array(z.object({ kind: z.string(), optionId: z.string() })),
  toolCall: z
    .object({ toolCallId: z.string(), title: z.string().nullable().optional() })
    .passthrough(),
})
const fileRequest = z.object({
  sessionId: z.string(),
  path: z.string(),
})
const readRequest = fileRequest.extend({
  line: z.number().int().positive().nullable().optional(),
  limit: z.number().int().nonnegative().nullable().optional(),
})
const writeRequest = fileRequest.extend({ content: z.string() })
const terminalRequest = z.object({
  sessionId: z.string(),
  terminalId: z.string(),
})
const createRequest = z.object({
  sessionId: z.string(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  cwd: z.string().nullable().optional(),
  env: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  outputByteLimit: z.number().int().positive().nullable().optional(),
})

type Logger = { debug(message: string, data?: unknown): void }
type Terminal = {
  process: ChildProcess
  chunks: Buffer[]
  bytes: number
  limit: number
  truncated: boolean
  exit: Promise<{ exitCode: number | null; signal: string | null }>
  status?: { exitCode: number | null; signal: string | null }
}

const defaultLogger: Logger = { debug: () => undefined }

function makeTerminalId(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let value = Date.now()
  let time = ''
  for (let index = 0; index < 10; index++) {
    time = alphabet[value % 32] + time
    value = Math.floor(value / 32)
  }
  let random = ''
  for (const byte of randomBytes(16)) random += alphabet[byte % 32]
  return time + random
}

function checkedPath(base: string, root: string, path: string): string {
  const full = resolve(base, path)
  const remainder = relative(resolve(root), full)
  if (
    remainder === '..' ||
    remainder.startsWith('..' + sep) ||
    isAbsolute(remainder)
  )
    throw new Error('ACP path is outside the project root')
  return full
}

function appendOutput(terminal: Terminal, chunk: Buffer) {
  if (terminal.limit <= 0) return
  const combined = Buffer.concat([...terminal.chunks, chunk])
  if (combined.byteLength > terminal.limit) terminal.truncated = true
  const tail = combined.subarray(
    Math.max(0, combined.byteLength - terminal.limit),
  )
  terminal.chunks = [tail]
  terminal.bytes = tail.byteLength
}

export type AcpServicesOptions = {
  cwd: string
  projectRoot: string
  logger?: Logger
  isUserQuestion?: (request: acp.RequestPermissionRequest) => boolean
  questionManager?: QuestionManager
}

export type AcpServices = ClientHandlers & {
  releaseSession(sessionId: string): Promise<void>
  cancelSession(sessionId: string): void
}

/** Client-side ACP services. Terminals use plain pipes; TTY semantics can be revisited later. */
export function createAcpServices(options: AcpServicesOptions): AcpServices {
  const logger = options.logger ?? defaultLogger
  const terminals = new Map<string, Terminal>()
  const cancelled = new Set<string>()
  const service: AcpServices = {
    onRequestPermission: async (request) => {
      const checked = permissionRequest.parse(request)
      if (options.isUserQuestion?.(request) ?? isUserQuestion(request)) {
        if (options.questionManager)
          return options.questionManager.handlePermission(request)
        return { outcome: { outcome: 'cancelled' } }
      }
      logger.debug('Auto-granted ACP permission', checked.toolCall.title)
      if (cancelled.has(request.sessionId))
        return { outcome: { outcome: 'cancelled' } }
      const selected =
        checked.options.find((option) => option.kind === 'allow_always') ??
        checked.options.find((option) => option.kind === 'allow_once') ??
        checked.options.find((option) => option.kind.startsWith('allow'))
      if (!selected) return { outcome: { outcome: 'cancelled' } }
      return { outcome: { outcome: 'selected', optionId: selected.optionId } }
    },
    onReadTextFile: async (request) => {
      const checked = readRequest.parse(request)
      const path = checkedPath(options.cwd, options.projectRoot, checked.path)
      const bun = (
        globalThis as typeof globalThis & {
          Bun?: { file(path: string): { text(): Promise<string> } }
        }
      ).Bun
      const content = bun
        ? await bun.file(path).text()
        : await readFile(path, 'utf8')
      const lines = content.split('\n')
      const start = (checked.line ?? 1) - 1
      return {
        content: lines
          .slice(
            start,
            checked.limit == null ? undefined : start + checked.limit,
          )
          .join('\n'),
      }
    },
    onWriteTextFile: async (request) => {
      const checked = writeRequest.parse(request)
      const path = checkedPath(options.cwd, options.projectRoot, checked.path)
      const bun = (
        globalThis as typeof globalThis & {
          Bun?: { write(path: string, content: string): Promise<number> }
        }
      ).Bun
      if (bun) await bun.write(path, checked.content)
      else await writeFile(path, checked.content)
      return {}
    },
    onTerminalCreate: async (request) => {
      const checked = createRequest.parse(request)
      const child = spawn(checked.command, checked.args ?? [], {
        cwd: checked.cwd
          ? checkedPath(options.cwd, options.projectRoot, checked.cwd)
          : options.cwd,
        env: {
          ...process.env,
          ...Object.fromEntries(
            (checked.env ?? []).map((entry) => [entry.name, entry.value]),
          ),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const terminal: Terminal = {
        process: child,
        chunks: [],
        bytes: 0,
        limit: checked.outputByteLimit ?? 1024 * 1024,
        truncated: false,
        exit: new Promise((resolveExit) => {
          child.once('exit', (exitCode, signal) => {
            terminal.status = { exitCode, signal }
            resolveExit(terminal.status)
          })
        }),
      }
      child.stdout.on('data', (chunk: Buffer) => appendOutput(terminal, chunk))
      child.stderr.on('data', (chunk: Buffer) => appendOutput(terminal, chunk))
      const terminalId = makeTerminalId()
      terminals.set(`${checked.sessionId}:${terminalId}`, terminal)
      return { terminalId }
    },
    onTerminalOutput: async (request) => {
      const checked = terminalRequest.parse(request)
      const terminal = terminals.get(
        `${checked.sessionId}:${checked.terminalId}`,
      )
      if (!terminal) throw new Error('ACP terminal not found')
      return {
        output: Buffer.concat(terminal.chunks).toString(),
        truncated: terminal.truncated,
        exitStatus: terminal.status,
      }
    },
    onTerminalWaitForExit: async (request) => {
      const checked = terminalRequest.parse(request)
      const terminal = terminals.get(
        `${checked.sessionId}:${checked.terminalId}`,
      )
      if (!terminal) throw new Error('ACP terminal not found')
      return await terminal.exit
    },
    onTerminalKill: async (request) => {
      const checked = terminalRequest.parse(request)
      const terminal = terminals.get(
        `${checked.sessionId}:${checked.terminalId}`,
      )
      if (!terminal) throw new Error('ACP terminal not found')
      terminal.process.kill('SIGTERM')
      return {}
    },
    onTerminalRelease: async (request) => {
      const checked = terminalRequest.parse(request)
      const key = `${checked.sessionId}:${checked.terminalId}`
      const terminal = terminals.get(key)
      if (terminal && !terminal.status) terminal.process.kill('SIGTERM')
      terminals.delete(key)
      return {}
    },
    onExtRequest: async (method, params) => {
      const question = options.questionManager?.handleExtension(method, params)
      if (question) return question
      throw acp.RequestError.methodNotFound(method)
    },
    onExtNotification: async (method) => {
      logger.debug('Ignored unknown ACP extension notification', method)
    },
    releaseSession: async (sessionId) => {
      options.questionManager?.releaseSession(sessionId)
      cancelled.add(sessionId)
      for (const [key, terminal] of terminals) {
        if (!key.startsWith(`${sessionId}:`)) continue
        if (!terminal.status) terminal.process.kill('SIGTERM')
        terminals.delete(key)
      }
    },
    cancelSession: (sessionId) => {
      options.questionManager?.cancelSession(sessionId)
      cancelled.add(sessionId)
    },
  }
  return service
}
