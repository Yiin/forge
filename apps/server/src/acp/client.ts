import { Readable } from 'node:stream'
import { spawn as spawnNode } from 'node:child_process'
import * as acp from '@agentclientprotocol/sdk'
import type { HarnessConfig } from '@forge/protocol/config'
import { detectProviderError, recordLimit } from '../accounts/limits.js'
import {
  createConfigOptionChannel,
  type SessionConfigOption,
} from './configOptions.js'

type Db = { prepare(sql: string): { run(...params: unknown[]): unknown } }

export class CapabilityUnsupportedError extends Error {
  constructor(readonly capability: string) {
    super(`ACP capability is not advertised: ${capability}`)
    this.name = 'CapabilityUnsupportedError'
  }
}

export class AgentProcessDiedError extends Error {
  constructor(
    readonly exitCode: number | null,
    readonly stderrTail: string,
  ) {
    super(
      `ACP agent exited${exitCode === null ? '' : ` with code ${exitCode}`}`,
    )
    this.name = 'AgentProcessDiedError'
  }
}

export type ClientHandlers = {
  /** Working directory for the ACP child process itself. */
  cwd?: string
  onSessionUpdate?: (
    notification: acp.SessionNotification,
  ) => void | Promise<void>
  onRequestPermission?: (
    request: acp.RequestPermissionRequest,
  ) => Promise<acp.RequestPermissionResponse>
  onReadTextFile?: (
    request: acp.ReadTextFileRequest,
  ) => Promise<acp.ReadTextFileResponse>
  onWriteTextFile?: (
    request: acp.WriteTextFileRequest,
  ) => Promise<acp.WriteTextFileResponse>
  onTerminalCreate?: (
    request: acp.CreateTerminalRequest,
  ) => Promise<acp.CreateTerminalResponse>
  onTerminalOutput?: (
    request: acp.TerminalOutputRequest,
  ) => Promise<acp.TerminalOutputResponse>
  onTerminalRelease?: (
    request: acp.ReleaseTerminalRequest,
  ) => Promise<acp.ReleaseTerminalResponse | void>
  onTerminalWaitForExit?: (
    request: acp.WaitForTerminalExitRequest,
  ) => Promise<acp.WaitForTerminalExitResponse>
  onTerminalKill?: (
    request: acp.KillTerminalCommandRequest,
  ) => Promise<acp.KillTerminalCommandResponse | void>
  onExtRequest?: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
  onExtNotification?: (
    method: string,
    params: Record<string, unknown>,
  ) => void | Promise<void>
  onExit?: (error: AgentProcessDiedError) => void | Promise<void>
  /** Optional persistence hook until the server database is wired to this module. */
  capabilityStore?: {
    db: Db
    harnessKey: string
    accountId?: string | null
    agentName?: string
  }
}

export type AcpCapabilities = {
  loadSession: boolean
  sessionResume: boolean
  sessionFork: boolean
  setMode: boolean
  setModel: boolean
  agent: acp.AgentCapabilities
}

export type PromptResponse = acp.PromptResponse

export type AcpClient = {
  capabilities: AcpCapabilities
  newSession(cwd: string): Promise<acp.NewSessionResponse>
  loadSession(sessionId: string, cwd: string): Promise<acp.LoadSessionResponse>
  /** Fork an existing provider session through ACP's unstable session/fork method. */
  fork(sessionId: string, cwd: string): Promise<acp.NewSessionResponse>
  forkSession(sessionId: string, cwd: string): Promise<acp.NewSessionResponse>
  prompt(sessionId: string, blocks: acp.ContentBlock[]): Promise<PromptResponse>
  cancel(sessionId: string): Promise<void>
  setMode(
    sessionId: string,
    modeId: string,
  ): Promise<acp.SetSessionModeResponse | void>
  setModel(
    sessionId: string,
    modelId: string,
  ): Promise<acp.SetSessionModelResponse | void>
  configOptions(sessionId: string): SessionConfigOption[]
  setConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<SessionConfigOption[]>
  kill(): Promise<void>
}

class RingBuffer {
  private value = ''
  push(chunk: string) {
    this.value = (this.value + chunk).slice(-4096)
  }
  toString() {
    return this.value
  }
}

const asWebReadable = (stream: ReadableStream<Uint8Array> | Readable) =>
  stream instanceof Readable
    ? (Readable.toWeb(stream) as ReadableStream<Uint8Array>)
    : stream

const asWebWritable = (
  stream: WritableStream<Uint8Array> | NodeJS.WritableStream,
) =>
  'getWriter' in stream
    ? stream
    : (Writable.toWeb(stream as never) as WritableStream<Uint8Array>)

// node:stream's Writable import is kept separate to avoid changing Bun's stream types.
import { Writable } from 'node:stream'

function persistCapabilities(
  db: Db,
  key: string,
  capabilities: unknown,
  agentName?: string,
) {
  db.prepare(
    `INSERT INTO harness_capabilities (harness_key, capabilities, agent_name, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(harness_key) DO UPDATE SET capabilities = excluded.capabilities,
       agent_name = excluded.agent_name, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(capabilities), agentName ?? null, Date.now())
}

export async function spawnAcpClient(
  entry: HarnessConfig,
  handlers: ClientHandlers = {},
): Promise<AcpClient> {
  if (entry.protocol !== 'acp')
    throw new Error(`Harness ${entry.name} is not an ACP harness`)
  const bun = (
    globalThis as typeof globalThis & {
      Bun: {
        spawn(
          command: string[],
          options: Record<string, unknown>,
        ): {
          stdin: WritableStream<Uint8Array>
          stdout: ReadableStream<Uint8Array>
          stderr: ReadableStream<Uint8Array>
          exited: Promise<number>
          kill(signal: string): void
        }
      }
    }
  ).Bun as
    | {
        spawn(command: string[], options: Record<string, unknown>): any
      }
    | undefined
  let spawnError: Error | undefined
  const process: any = bun
    ? bun.spawn([entry.command, ...entry.args], {
        env: { ...globalThis.process.env, ...entry.env },
        cwd: handlers.cwd,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })
    : (() => {
        const child = spawnNode(entry.command, entry.args, {
          env: { ...globalThis.process.env, ...entry.env },
          cwd: handlers.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        return {
          stdin: child.stdin!,
          stdout: child.stdout!,
          stderr: child.stderr!,
          exited: new Promise<number>((resolve) => {
            child.once('error', (error) => {
              spawnError = error
              resolve(1)
            })
            child.once('exit', (code) => resolve(code ?? 0))
          }),
          kill: (signal: string) => child.kill(signal as NodeJS.Signals),
        }
      })()
  const stderr = new RingBuffer()
  void (async () => {
    const reader = asWebReadable(process.stderr).getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        stderr.push(decoder.decode(chunk.value, { stream: true }))
      }
    } finally {
      reader.releaseLock()
    }
  })()

  let dead: AgentProcessDiedError | undefined
  let rejectConfigPending: ((error: unknown) => void) | undefined
  let rejectDeath!: (error: AgentProcessDiedError) => void
  const death = new Promise<never>((_, reject) => (rejectDeath = reject))
  void death.catch(() => undefined)
  void process.exited.then((exitCode: number) => {
    dead = new AgentProcessDiedError(
      exitCode,
      [stderr.toString(), spawnError?.message].filter(Boolean).join('\n'),
    )
    rejectConfigPending?.(dead)
    const match = detectProviderError(dead.stderrTail)
    const accountId = handlers.capabilityStore?.accountId
    if (match && accountId)
      recordLimit(handlers.capabilityStore!.db, {
        accountId,
        kind: match.category,
        harnessKey: handlers.capabilityStore!.harnessKey,
        detectedAt: Date.now(),
        source: 'acp.stderr',
        detail: match.excerpt,
      })
    rejectDeath(dead)
    void handlers.onExit?.(dead)
  })
  const alive = <T>(operation: Promise<T>) =>
    operation.catch((error) => {
      if (dead) throw dead
      throw error
    })
  const race = <T>(operation: Promise<T>) =>
    Promise.race([alive(operation), death])

  const client: acp.Client = {
    requestPermission: (request) =>
      handlers.onRequestPermission?.(request) ??
      Promise.resolve({ outcome: { outcome: 'cancelled' } }),
    sessionUpdate: (notification) =>
      (handlers.onSessionUpdate?.(notification) as Promise<void>) ??
      Promise.resolve(),
    readTextFile: handlers.onReadTextFile,
    writeTextFile: handlers.onWriteTextFile,
    createTerminal: handlers.onTerminalCreate,
    terminalOutput: handlers.onTerminalOutput,
    releaseTerminal: handlers.onTerminalRelease,
    waitForTerminalExit: handlers.onTerminalWaitForExit,
    killTerminal: handlers.onTerminalKill,
    extMethod: handlers.onExtRequest,
    extNotification: handlers.onExtNotification
      ? (method, params) =>
          Promise.resolve(handlers.onExtNotification?.(method, params))
      : undefined,
  }
  const configOptions = new Map<string, SessionConfigOption[]>()
  const rawStream = acp.ndJsonStream(
    asWebWritable(process.stdin),
    asWebReadable(process.stdout),
  )
  const configChannel = createConfigOptionChannel(rawStream, {
    onConfigOptions: (sessionId, options) =>
      configOptions.set(sessionId, options),
  })
  rejectConfigPending = configChannel.rejectPending
  const connection = new acp.ClientSideConnection(
    () => client,
    configChannel.stream,
  )
  const initialized = await race(
    connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    }),
  )
  if (initialized.authMethods?.length)
    try {
      await race(
        connection.authenticate({ methodId: initialized.authMethods[0].id }),
      )
    } catch {
      // Agents advertise authMethods even when already authenticated, and some
      // (claude-code-acp) do not implement authenticate at all. Auth is
      // enforced per request via authRequired, so a failed proactive
      // handshake must not kill the spawn.
    }
  const agent = initialized.agentCapabilities ?? {}
  const capabilities: AcpCapabilities = {
    loadSession: agent.loadSession === true,
    sessionResume: Boolean((agent as Record<string, unknown>).sessionResume),
    sessionFork: Boolean(
      (agent as Record<string, unknown>).sessionFork ??
      (agent as { session?: { fork?: unknown } }).session?.fork !== undefined,
    ),
    setMode: false,
    setModel: false,
    agent,
  }
  if (handlers.capabilityStore)
    persistCapabilities(
      handlers.capabilityStore.db,
      handlers.capabilityStore.harnessKey,
      agent,
      handlers.capabilityStore.agentName,
    )

  const sessionFeatures = new Map<string, { mode: boolean; model: boolean }>()
  const seedConfigOptions = (sessionId: string, response: unknown) => {
    const options = (response as { configOptions?: unknown }).configOptions
    if (Array.isArray(options))
      configOptions.set(sessionId, options as SessionConfigOption[])
  }
  const activePrompts = new Set<string>()
  const newSession = async (cwd: string) => {
    const response = await race(connection.newSession({ cwd, mcpServers: [] }))
    sessionFeatures.set(response.sessionId, {
      mode: Boolean(response.modes?.availableModes?.length),
      model: Boolean(response.models?.availableModels?.length),
    })
    seedConfigOptions(response.sessionId, response)
    capabilities.setMode ||= Boolean(response.modes?.availableModes?.length)
    capabilities.setModel ||= Boolean(response.models?.availableModels?.length)
    return response
  }
  const acpClient: AcpClient = {
    capabilities,
    newSession,
    loadSession: async (sessionId, cwd) => {
      if (!capabilities.loadSession)
        throw new CapabilityUnsupportedError('loadSession')
      const response = await race(
        connection.loadSession({ sessionId, cwd, mcpServers: [] }),
      )
      sessionFeatures.set(sessionId, {
        mode: Boolean(response.modes?.availableModes?.length),
        model: Boolean(response.models?.availableModels?.length),
      })
      seedConfigOptions(sessionId, response)
      capabilities.setMode ||= Boolean(response.modes?.availableModes?.length)
      capabilities.setModel ||= Boolean(
        response.models?.availableModels?.length,
      )
      return response
    },
    fork: async (sessionId, cwd) => {
      if (!capabilities.sessionFork)
        throw new CapabilityUnsupportedError('sessionFork')
      const params = { sessionId, cwd, mcpServers: [] as [] }
      // ACP 0.4 has no typed session/fork method yet. Use the generic
      // extension request until the dependency adds the unstable method.
      const response = (await race(
        connection.extMethod('session/fork', params),
      )) as unknown as acp.NewSessionResponse
      sessionFeatures.set(response.sessionId, {
        mode: Boolean(response.modes?.availableModes?.length),
        model: Boolean(response.models?.availableModels?.length),
      })
      seedConfigOptions(response.sessionId, response)
      capabilities.setMode ||= Boolean(response.modes?.availableModes?.length)
      capabilities.setModel ||= Boolean(
        response.models?.availableModels?.length,
      )
      return response
    },
    forkSession: (sessionId, cwd) => acpClient.fork(sessionId, cwd),
    prompt: async (sessionId, blocks) => {
      if (activePrompts.has(sessionId))
        throw new Error(`Prompt already active for session ${sessionId}`)
      if (sessionFeatures.get(sessionId)?.mode === undefined)
        sessionFeatures.set(sessionId, { mode: false, model: false })
      activePrompts.add(sessionId)
      try {
        return await race(connection.prompt({ sessionId, prompt: blocks }))
      } finally {
        activePrompts.delete(sessionId)
      }
    },
    cancel: (sessionId) => alive(connection.cancel({ sessionId })),
    setMode: async (sessionId, modeId) => {
      if (!sessionFeatures.get(sessionId)?.mode)
        throw new CapabilityUnsupportedError('setMode')
      return race(connection.setSessionMode({ sessionId, modeId }))
    },
    setModel: async (sessionId, modelId) => {
      if (!sessionFeatures.get(sessionId)?.model)
        throw new CapabilityUnsupportedError('setModel')
      return race(connection.unstable_setSessionModel({ sessionId, modelId }))
    },
    configOptions: (sessionId) => configOptions.get(sessionId) ?? [],
    setConfigOption: async (sessionId, configId, value) => {
      if (!configOptions.has(sessionId))
        throw new CapabilityUnsupportedError('setConfigOption')
      const options = await race(
        configChannel.setConfigOption(sessionId, configId, value),
      )
      configOptions.set(sessionId, options)
      return options
    },
    kill: async () => {
      if (dead) return
      process.kill('SIGTERM')
      await Promise.race([
        process.exited,
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ])
      if (!dead) process.kill('SIGKILL')
    },
  }
  return acpClient
}
