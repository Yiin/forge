import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import {
  zInitializeResponse,
  zNewSessionResponse,
  zLoadSessionResponse,
} from '@agentclientprotocol/sdk/dist/schema/zod.gen.js'
import { confirmedNativeBindingSchema } from '@forge/protocol/harness'
import type { ConfirmedNativeBinding, HarnessSession } from '../types.js'
import { startNativeProcess, type NativeProcess } from '../process.js'
import { JsonlRpcTransport, type JsonRpcIncoming } from '../jsonrpc.js'
import type { JsonlValueOwnership, SubmissionEvidence } from '../jsonl.js'
import {
  AcpJournal,
  type AccountScope,
  type AcpControlOwner,
  type AcpIngestionFactory,
  type AcpRecordOwner,
  type AcpTicket,
} from './ingestion.js'
import { captureNumbers, type NumericCapture } from './numbers.js'
import {
  captureLaunch,
  acpProviderDescriptors,
  resolveExecutable,
  type AcpLaunch,
  type AcpProfile,
} from './profiles.js'
import { AcpCatalog } from './config.js'
import type { AcpResourceHost } from './limits.js'
import { immutableData } from './data.js'
import { positiveLimit } from '../diagnostics.js'

export type AcpFrame = {
  readonly owner: AcpRecordOwner
  readonly ticket: AcpTicket
  readonly numbers: NumericCapture
  readonly wireOrdinal: number
  claimed: boolean
}
type Call = {
  owner: AcpRecordOwner
  active: boolean
  frame?: AcpFrame
  release?: () => void
}
export type AcpConnectionOptions = {
  profile: AcpProfile
  launch: AcpLaunch
  host: AcpResourceHost
  ingestion: AcpIngestionFactory
  controlMs?: number
  route(
    strings: Readonly<Record<string, string>>,
    fallback: AcpRecordOwner,
  ): AcpRecordOwner
  incoming(
    message: JsonRpcIncoming,
    frame: AcpFrame,
    connection: AcpConnection,
  ): Promise<void>
  failure(error: unknown): void
}

async function openWriter(
  options: AcpConnectionOptions,
  input: Parameters<AcpIngestionFactory['open']>[0],
  controller: AbortController,
) {
  const timeoutMs = positiveLimit(
    options.controlMs ?? 15000,
    'ACP writer deadline',
  )
  const release = options.host.reserve(
    options.launch.providerInstanceId,
    'commits',
  )
  return new Promise<{
    writer: Awaited<ReturnType<AcpIngestionFactory['open']>>
    release: () => void
  }>((resolve, reject) => {
    let abandoned = false
    const timer = setTimeout(() => {
      abandoned = true
      controller.abort()
      reject(Error('ACP writer opening timed out'))
    }, timeoutMs)
    let opening: ReturnType<AcpIngestionFactory['open']>
    try {
      opening = options.ingestion.open(input, controller.signal)
    } catch (error) {
      clearTimeout(timer)
      release()
      reject(error)
      return
    }
    void opening
      .then(
        async (writer) => {
          clearTimeout(timer)
          if (abandoned) {
            await writer.close()
            release()
          } else {
            resolve({ writer, release })
          }
        },
        (error) => {
          clearTimeout(timer)
          release()
          reject(error)
        },
      )
      .catch((error) => {
        try {
          options.failure(error)
        } catch {
          /* The unresolved writer keeps its original resource lease. */
        }
      })
  })
}

export class AcpConnection {
  readonly generation: string = randomUUID()
  readonly catalog: AcpCatalog
  readonly account: AccountScope
  readonly launch: AcpLaunch
  readonly session: HarnessSession
  readonly control: AcpControlOwner
  readonly journal: AcpJournal
  readonly rpc: JsonlRpcTransport
  readonly process: NativeProcess
  private readonly calls = new Map<string, Call>()
  private current: AcpRecordOwner
  private confirmed: ConfirmedNativeBinding | null = null
  private wireOrdinal = 0
  private closing?: Promise<void>
  private constructor(
    private readonly options: AcpConnectionOptions,
    session: HarnessSession,
    launch: AcpLaunch,
    journal: AcpJournal,
    runtime: NativeProcess,
    control: AcpControlOwner,
    private readonly releaseProcess: () => void,
  ) {
    this.session = session
    this.launch = launch
    this.control = control
    this.generation = control.runtimeGeneration
    this.account = control.account
    this.current = control
    this.journal = journal
    this.process = runtime
    this.catalog = new AcpCatalog(options.profile)
    this.rpc = new JsonlRpcTransport({
      stdin: runtime.child.stdin,
      stdout: runtime.child.stdout,
      runtimeGeneration: this.generation,
      maxLineBytes: 16 * 1024 * 1024,
      maxQueuedFrames: 32,
      maxQueuedBytes: 32 * 1024 * 1024,
      maxPendingRequests: 16,
      maxIncomingRequests: 32,
      maxIncomingHandlers: 32,
      maxQueuedIncomingFrames: 64,
      maxQueuedIncomingBytes: 32 * 1024 * 1024,
      requestTimeoutMs: options.controlMs ?? 15000,
      secrets: launch.secrets,
      resources: options.host.transport(launch.providerInstanceId),
      captureFrame: (source) => {
        const strings: Record<string, string> = Object.create(null)
        let stringBytes = 0
        const numbers = captureNumbers(source, (path, value) => {
          if (
            path === '/id' ||
            path === '/method' ||
            (path.startsWith('/params/') &&
              path.split('/').length <= 7 &&
              /\/(sessionId|session_id|parent_session_id|child_session_id|subagent_id|agentId|parentAgentId|attempt_id|parent_prompt_id|prompt_id|promptId|type|sessionUpdate|toolCallId)$/.test(
                path,
              ))
          ) {
            stringBytes += Buffer.byteLength(path) + Buffer.byteLength(value)
            if (stringBytes > 16384 || Buffer.byteLength(value) > 512)
              throw Error('ACP routing metadata exceeds limit')
            strings[path] = value
          }
        })
        const response =
          strings['/method'] === undefined
            ? this.calls.get(strings['/id'] ?? '')
            : undefined
        const owner =
          response?.owner ?? options.route(Object.freeze(strings), this.current)
        const wireOrdinal = ++this.wireOrdinal
        const ticket = journal.reserve(owner, {
          kind: 'native',
          producerTicket: randomUUID(),
          transportGeneration: this.generation,
          wireOrdinal,
        })
        const frame: AcpFrame = {
          owner,
          ticket,
          numbers,
          wireOrdinal,
          claimed: false,
        }
        return {
          context: frame,
          release() {
            if (!frame.claimed) {
              frame.claimed = true
              ticket.finish([
                { value: { kind: 'disposition', status: 'ignored' } },
              ])
            }
          },
        }
      },
      onEnvelope: (value, ownership) => {
        if (
          !value ||
          typeof value !== 'object' ||
          'method' in value ||
          !('id' in value) ||
          typeof value.id !== 'string'
        )
          return
        const call = this.calls.get(value.id),
          frame = this.frame(ownership)
        if (call?.active && !call.frame && frame) {
          frame.claimed = true
          call.frame = frame
        }
      },
      onIncoming: async (message) => {
        const frame = this.frame(message.ownership)
        if (!frame) throw Error('ACP frame lost its original admission')
        frame.claimed = true
        try {
          await options.incoming(message, frame, this)
        } catch (error) {
          try {
            frame.ticket.finish([
              { value: { kind: 'disposition', status: 'failed' } },
            ])
          } catch {
            /* Original ticket may already be committed. */
          }
          options.failure(error)
          throw error
        }
      },
    })
    runtime.ownTransport(this.rpc)
    void runtime.done
      .then((reason) => {
        if (!this.closing) options.failure(reason)
      })
      .catch(() => {})
  }
  private frame(ownership?: JsonlValueOwnership) {
    return ownership?.capture as AcpFrame | undefined
  }
  get binding() {
    return this.confirmed
  }
  setOwner(owner: AcpRecordOwner | null) {
    this.current = owner ? immutableData(owner) : this.control
  }
  call(
    method: string,
    params: unknown,
    owner: AcpRecordOwner,
    options: {
      signal?: AbortSignal
      timeoutMs?: number
      onHandoff?: (id: string) => void
    } = {},
  ): {
    response: Promise<{ value: unknown; frame: AcpFrame }>
    submission: Promise<SubmissionEvidence>
  } {
    const captured = immutableData(owner)
    const release = this.options.host.reserve(
      this.launch.providerInstanceId,
      'calls',
    )
    const call: Call = { owner: captured, active: true }
    let id: string | undefined
    let request: ReturnType<JsonlRpcTransport['requestWithSubmission']>
    try {
      request = this.rpc.requestWithSubmission(method, params, {
        ...options,
        onHandoff: (requestId) => {
          if (this.calls.size >= 4096)
            throw Error('ACP original call identity limit reached')
          call.release = this.options.host.reserve(
            this.launch.providerInstanceId,
            'retained',
            Buffer.byteLength(JSON.stringify(captured)) + 256,
          )
          id = requestId
          this.calls.set(requestId, call)
          options.onHandoff?.(requestId)
        },
      })
    } catch (error) {
      release()
      if (id) this.calls.delete(id)
      call.release?.()
      throw error
    }
    void request.submission.then((evidence) => {
      if (evidence.status === 'not_written') {
        if (id) this.calls.delete(id)
        call.release?.()
      }
    })
    const response = request.response
      .then(
        (value) => {
          call.active = false
          if (!call.frame) throw Error('ACP response lost its original frame')
          return { value, frame: call.frame }
        },
        async (error) => {
          call.active = false
          if (call.frame) {
            call.frame.ticket.finish([
              { value: { kind: 'disposition', status: 'failed' } },
            ])
            await call.frame.ticket.committed
          }
          throw error
        },
      )
      .finally(() => {
        release()
        call.active = false
        call.frame = undefined
      })
    void response.catch(() => {})
    return { response, submission: request.submission }
  }
  async controlCall(method: string, params: unknown, owner = this.current) {
    const { value, frame } = await this.call(method, params, owner).response
    frame.ticket.finish([{ value: { kind: 'disposition', status: 'ignored' } }])
    await frame.ticket.committed
    return value
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      await this.process.close()
      this.releaseProcess()
      for (const call of this.calls.values()) call.release?.()
      this.calls.clear()
      await this.journal.close()
    })()
    return this.closing
  }
  static async open(
    options: AcpConnectionOptions,
    input: HarnessSession,
    load: boolean,
  ): Promise<AcpConnection> {
    if (load && !acpProviderDescriptors[options.profile].load)
      throw Error('load_replay_unsupported')
    const launch = captureLaunch(options.profile, options.launch),
      session = immutableData(input)
    const cwd = await realpath(session.cwd)
    const account: AccountScope =
      launch.account.kind === 'selected-account'
        ? { kind: 'selected-account', accountId: launch.account.accountId }
        : {
            kind: 'native-default',
            configurationId: launch.account.configurationId,
          }
    if (
      session.provider !== launch.providerInstanceId ||
      (session.accountId ?? null) !==
        (account.kind === 'selected-account' ? account.accountId : null)
    )
      throw Error('ACP session provider or account differs')
    let expected: ConfirmedNativeBinding | null = null
    if (load) {
      expected = immutableData(
        confirmedNativeBindingSchema.parse(session.binding),
      )
      if (
        expected.provider !== session.provider ||
        expected.accountId !== (session.accountId ?? null) ||
        expected.cwd !== cwd
      )
        throw Error('ACP persisted binding differs')
    } else if (session.binding?.providerSessionId)
      throw Error('ACP spawn cannot replace an existing binding')
    const control: AcpControlOwner = immutableData({
      phase: 'control',
      sessionId: session.id,
      providerInstanceId: launch.providerInstanceId,
      account,
      runtimeGeneration: randomUUID(),
      startupId: randomUUID(),
      expectedBinding: expected,
    })
    const controller = new AbortController()
    const opened = await openWriter(
      options,
      immutableData({
        sessionId: session.id,
        providerInstanceId: launch.providerInstanceId,
        account,
        expectedBinding: expected,
      }),
      controller,
    )
    let journal: AcpJournal
    try {
      journal = new AcpJournal(opened.writer, {
        host: options.host,
        instanceId: launch.providerInstanceId,
        onFailure: () => {
          controller.abort()
          options.failure(Error('ACP ingestion failed'))
        },
        commitMs: options.controlMs,
      })
    } catch (error) {
      void Promise.resolve()
        .then(() => opened.writer.close())
        .then(opened.release)
        .catch((cleanupError) => {
          try {
            options.failure(cleanupError)
          } catch {
            /* Keep the original writer lease. */
          }
        })
      throw error
    }
    opened.release()
    let releaseProcess: () => void
    try {
      releaseProcess = options.host.reserve(
        launch.providerInstanceId,
        'processes',
      )
    } catch (error) {
      await journal.close()
      throw error
    }
    let connection: AcpConnection | undefined
    let created: NativeProcess | undefined
    try {
      const executable = await resolveExecutable(launch)
      if (!executable) throw Error('ACP executable is missing')
      const started = await startNativeProcess(
        {
          command: executable,
          onCreated: (runtime) => {
            created = runtime
          },
          args: [...launch.args],
          cwd,
          env: launch.env,
          inheritEnv: false,
          secrets: launch.secrets,
          signal: controller.signal,
          startupTimeoutMs: options.controlMs ?? 15000,
        },
        async (runtime) => {
          connection = new AcpConnection(
            options,
            { ...session, cwd },
            launch,
            journal,
            runtime,
            control,
            releaseProcess,
          )
          const initialized = zInitializeResponse.parse(
            await connection.controlCall(
              'initialize',
              {
                protocolVersion: 1,
                clientCapabilities: {
                  fs: { readTextFile: false, writeTextFile: false },
                  terminal: false,
                },
                clientInfo: { name: 'forge', version: '1' },
              },
              control,
            ),
          )
          if (initialized.protocolVersion !== 1)
            throw Error('ACP protocol version is unsupported')
          if (load && initialized.agentCapabilities?.loadSession !== true)
            throw Error('ACP load is not advertised')
          const owner: AcpRecordOwner = load
            ? immutableData({
                sessionId: session.id,
                providerInstanceId: launch.providerInstanceId,
                account,
                runtimeGeneration: control.runtimeGeneration,
                phase: 'load_replay',
                binding: expected!,
                loadId: randomUUID(),
                requestedNativeSessionId: expected!.providerSessionId,
              })
            : control
          connection.setOwner(owner)
          let response: { value: unknown; frame: AcpFrame } | undefined
          try {
            response = await connection.call(
              load ? 'session/load' : 'session/new',
              {
                cwd,
                mcpServers: [],
                ...(load ? { sessionId: expected!.providerSessionId } : {}),
              },
              owner,
            ).response
            const result = load
              ? zLoadSessionResponse.parse(response.value)
              : zNewSessionResponse.parse(response.value)
            if (
              load &&
              response.value &&
              typeof response.value === 'object' &&
              'sessionId' in response.value &&
              response.value.sessionId !== expected!.providerSessionId
            )
              throw Error('ACP loaded a conflicting native session')
            const binding =
              expected ??
              immutableData(
                confirmedNativeBindingSchema.parse({
                  provider: session.provider,
                  accountId: session.accountId ?? null,
                  cwd,
                  providerSessionId: (result as { sessionId: string })
                    .sessionId,
                }),
              )
            connection.catalog.update(result)
            response.frame.ticket.finish([
              { value: { kind: 'binding', binding } },
              ...(load
                ? [
                    {
                      value: {
                        kind: 'disposition' as const,
                        status: 'replay_visible' as const,
                      },
                    },
                  ]
                : []),
            ])
            await response.frame.ticket.committed
            connection.confirmed = binding
            connection.setOwner(null)
            return connection
          } catch (error) {
            try {
              if (!response) {
                await journal.append(owner, {
                  kind: 'disposition',
                  status: load ? 'replay_discarded' : 'failed',
                })
              } else {
                response.frame.ticket.finish([
                  {
                    value: {
                      kind: 'disposition',
                      status: load ? 'replay_discarded' : 'failed',
                    },
                  },
                ])
                await response.frame.ticket.committed
              }
            } catch {
              /* Preserve the original failure; journal failure remains latched. */
            }
            throw error
          }
        },
      )
      return started.value
    } catch (error) {
      if (connection) await connection.close()
      else {
        if (created) await created.close()
        releaseProcess()
        await journal.close()
      }
      throw error
    }
  }
}
