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
import type {
  JsonlValueOwnership,
  SubmissionEvidence,
  JsonlFrameCapture,
  JsonlDeferredCapture,
} from '../jsonl.js'
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
import { NativeCleanupError } from '../native-cleanup.js'
import type { AcpChildAdmission } from './children.js'

export type AcpFrame = {
  readonly owner: AcpRecordOwner
  readonly ticket: AcpTicket
  readonly numbers: NumericCapture
  readonly wireOrdinal: number
  readonly childAdmission?: AcpChildAdmission
  claimed: boolean
}
type Call = {
  owner: AcpRecordOwner
  active: boolean
  frame?: AcpFrame
  release?: () => void
}
export type AcpConnectionOptions = {
  initialPolicy?: 'manual' | 'yolo'
  profile: AcpProfile
  launch: AcpLaunch
  host: AcpResourceHost
  ingestion: AcpIngestionFactory
  controlMs?: number
  prepareClient?(connection: AcpConnection): Promise<{
    fs: { readTextFile: boolean; writeTextFile: boolean }
    terminal: boolean
  }>
  route(
    strings: Readonly<Record<string, string>>,
    fallback: AcpRecordOwner,
    numbers: NumericCapture,
    wireOrdinal: number,
    transportGeneration: string,
  ):
    | AcpRecordOwner
    | { owner: AcpRecordOwner; childAdmission: AcpChildAdmission }
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
  private controlOwner: AcpControlOwner
  get control() {
    return this.controlOwner
  }
  readonly journal: AcpJournal
  private transportRpc!: JsonlRpcTransport
  get rpc() {
    return this.transportRpc
  }
  private transportProcess!: NativeProcess
  get process() {
    return this.transportProcess
  }
  private calls = new Map<string, Call>()
  private current: AcpRecordOwner
  private confirmed: ConfirmedNativeBinding | null = null
  private capabilities: {
    image?: boolean
    audio?: boolean
    embeddedContext?: boolean
  } = {}
  get promptCapabilities() {
    return this.capabilities
  }
  private wireOrdinal = 0
  private closing?: Promise<void>
  private replacing?: {
    policy: 'manual' | 'yolo'
    promise: Promise<AcpConnection>
  }
  private readonly retiring = new WeakSet<NativeProcess>()
  private candidate?: { runtime?: NativeProcess; release(): void }
  private currentTransportGeneration = ''
  get transportGeneration() {
    return this.currentTransportGeneration
  }
  private constructor(
    private readonly options: AcpConnectionOptions,
    session: HarnessSession,
    launch: AcpLaunch,
    journal: AcpJournal,
    runtime: NativeProcess,
    control: AcpControlOwner,
    private releaseProcess: () => void,
    private readonly controller: AbortController,
  ) {
    this.session = session
    this.launch = launch
    this.controlOwner = control
    this.generation = control.runtimeGeneration
    this.account = control.account
    this.current = control
    this.journal = journal
    this.catalog = new AcpCatalog(options.profile)
    this.attach(runtime, control, releaseProcess)
  }
  private attach(
    runtime: NativeProcess,
    control: AcpControlOwner,
    releaseProcess: () => void,
  ) {
    const options = this.options,
      launch = this.launch,
      journal = this.journal
    const transportGeneration = randomUUID(),
      calls = new Map<string, Call>()
    this.currentTransportGeneration = transportGeneration
    this.calls = calls
    this.transportProcess = runtime
    this.controlOwner = control
    this.current = control
    this.releaseProcess = releaseProcess
    this.candidate = undefined
    this.transportRpc = new JsonlRpcTransport({
      stdin: runtime.child.stdin,
      stdout: runtime.child.stdout,
      runtimeGeneration: transportGeneration,
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
      maxUnreadBytes: 32 * 1024 * 1024,
      captureReadContext: () => this.current,
      captureFrame: (source, readContext) => {
        let releaseCapture = options.host.reserve(
          launch.providerInstanceId,
          'retained',
          4 * 1024 * 1024 + source.length * 2,
        )
        let retained = true
        const release = () => {
          if (retained) {
            retained = false
            releaseCapture()
          }
        }
        try {
          const strings: Record<string, string> = Object.create(null)
          let stringBytes = 0
          const numbers = captureNumbers(source, (path, value) => {
            if (
              path === '/id' ||
              path === '/method' ||
              (path.startsWith('/params/') &&
                path.split('/').length <= 7 &&
                /\/(sessionId|session_id|parent_session_id|child_session_id|subagent_id|agentId|parentAgentId|attempt_id|parent_prompt_id|prompt_id|promptId|message_id|type|sessionUpdate|toolCallId)$/.test(
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
              ? calls.get(strings['/id'] ?? '')
              : undefined
          const wireOrdinal = ++this.wireOrdinal
          const routing =
            response?.owner ??
            options.route(
              Object.freeze(strings),
              readContext as AcpRecordOwner,
              numbers,
              wireOrdinal,
              transportGeneration,
            )
          const owner = 'owner' in routing ? routing.owner : routing
          const childAdmission =
            'owner' in routing ? routing.childAdmission : undefined
          const releaseRetained = options.host.reserve(
            launch.providerInstanceId,
            'retained',
            65536 +
              stringBytes * 4 +
              numbers.numbers.reduce(
                (bytes, token) =>
                  bytes +
                  128 +
                  4 *
                    (Buffer.byteLength(token.path) +
                      Buffer.byteLength(token.text)),
                0,
              ),
          )
          releaseCapture()
          releaseCapture = releaseRetained
          const admit = (): JsonlFrameCapture | JsonlDeferredCapture => {
            const ready = journal.admissionReady()
            if (ready) return { ready, resume: admit, release }
            const ticket = journal.reserve(owner, {
              kind: 'native',
              producerTicket: randomUUID(),
              transportGeneration,
              wireOrdinal,
            })
            const frame: AcpFrame = {
              owner,
              ticket,
              numbers,
              wireOrdinal,
              claimed: false,
              childAdmission,
            }
            return {
              context: frame,
              release() {
                release()
                if (!frame.claimed) {
                  frame.claimed = true
                  try {
                    ticket.finish([
                      { value: { kind: 'disposition', status: 'ignored' } },
                    ])
                  } catch (error) {
                    ticket.failAdmission()
                    throw error
                  }
                }
              },
            }
          }
          return admit()
        } catch (error) {
          release()
          throw error
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
        const call = calls.get(value.id),
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
            try {
              frame.ticket.failAdmission()
            } catch {
              /* Finished tickets retain their original authority. */
            }
          }
          options.failure(error)
          throw error
        }
      },
    })
    runtime.ownTransport(this.rpc)
    void runtime.done
      .then((reason) => {
        if (!this.retiring.has(runtime) && !this.closing)
          options.failure(reason)
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
    const calls = this.calls,
      rpc = this.rpc
    const captured = immutableData(owner)
    const release = this.options.host.reserve(
      this.launch.providerInstanceId,
      'calls',
    )
    const call: Call = { owner: captured, active: true }
    let id: string | undefined
    let request: ReturnType<JsonlRpcTransport['requestWithSubmission']>
    try {
      request = rpc.requestWithSubmission(method, params, {
        ...options,
        onHandoff: (requestId) => {
          if (calls.size >= 4096)
            throw Error('ACP original call identity limit reached')
          call.release = this.options.host.reserve(
            this.launch.providerInstanceId,
            'retained',
            Buffer.byteLength(JSON.stringify(captured)) + 256,
          )
          id = requestId
          calls.set(requestId, call)
          options.onHandoff?.(requestId)
        },
      })
    } catch (error) {
      release()
      if (id) calls.delete(id)
      call.release?.()
      throw error
    }
    void request.submission.then((evidence) => {
      if (evidence.status === 'not_written') {
        if (id) calls.delete(id)
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
  async retireProcess(): Promise<void> {
    const runtime = this.process,
      calls = this.calls,
      release = this.releaseProcess,
      candidate = this.candidate
    this.retiring.add(runtime)
    await runtime.close()
    release()
    for (const call of calls.values()) call.release?.()
    calls.clear()
    if (candidate) {
      await candidate.runtime?.close()
      candidate.release()
      if (this.candidate === candidate) this.candidate = undefined
    }
  }
  replace(initialPolicy: 'manual' | 'yolo'): Promise<AcpConnection> {
    if (
      !['manual', 'yolo'].includes(initialPolicy) ||
      this.closing ||
      this.controller.signal.aborted ||
      !this.confirmed
    )
      return Promise.reject(Error('ACP connection cannot be replaced'))
    if (this.replacing) {
      if (this.replacing.policy !== initialPolicy)
        return Promise.reject(Error('ACP replacement policy differs'))
      return this.replacing.promise
    }
    const promise = Promise.resolve()
      .then(async () => {
        await this.retireProcess()
        if (this.closing || this.controller.signal.aborted)
          throw Error('ACP connection is closing')
        return AcpConnection.openOwned(
          { ...this.options, initialPolicy },
          { ...this.session, binding: this.confirmed },
          true,
          this,
        )
      })
      .finally(() => {
        this.replacing = undefined
      })
    this.replacing = { policy: initialPolicy, promise }
    return promise
  }
  close(): Promise<void> {
    if (!this.closing) {
      const closing = Promise.resolve().then(async () => {
        await this.replacing?.promise.catch(() => {})
        await this.retireProcess()
        await this.journal.close()
      })
      this.closing = closing
      void closing.catch(() => {
        if (this.closing === closing) this.closing = undefined
      })
    }
    this.controller.abort()
    return this.closing
  }
  static open(
    options: AcpConnectionOptions,
    input: HarnessSession,
    load: boolean,
  ): Promise<AcpConnection> {
    return this.openOwned(options, input, load)
  }
  private static async openOwned(
    options: AcpConnectionOptions,
    input: HarnessSession,
    load: boolean,
    existing?: AcpConnection,
  ): Promise<AcpConnection> {
    const initialPolicy = options.initialPolicy ?? 'manual'
    if (!['manual', 'yolo'].includes(initialPolicy))
      throw Error('Invalid ACP initial policy')
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
      runtimeGeneration: existing?.generation ?? randomUUID(),
      startupId: randomUUID(),
      expectedBinding: expected,
    })
    const controller = existing?.controller ?? new AbortController()
    controller.signal.throwIfAborted()
    let journal: AcpJournal
    if (existing) journal = existing.journal
    else {
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
    }
    let releaseProcess: () => void
    try {
      releaseProcess = options.host.reserve(
        launch.providerInstanceId,
        'processes',
      )
    } catch (error) {
      if (!existing) await journal.close()
      throw error
    }
    if (existing) existing.candidate = { release: releaseProcess }
    let connection: AcpConnection | undefined
    let created: NativeProcess | undefined
    try {
      const executable = await resolveExecutable(launch)
      if (!executable) throw Error('ACP executable is missing')
      controller.signal.throwIfAborted()
      const started = await startNativeProcess(
        {
          command: executable,
          onCreated: (runtime) => {
            created = runtime
            if (existing?.candidate) existing.candidate.runtime = runtime
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
          if (existing) {
            existing.attach(runtime, control, releaseProcess)
            connection = existing
          } else
            connection = new AcpConnection(
              options,
              { ...session, cwd },
              launch,
              journal,
              runtime,
              control,
              releaseProcess,
              controller,
            )
          const clientCapabilities = (await options.prepareClient?.(
            connection,
          )) ?? {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          }
          const initialized = zInitializeResponse.parse(
            await connection.controlCall(
              'initialize',
              {
                protocolVersion: 1,
                clientCapabilities,
                clientInfo: { name: 'forge', version: '1' },
              },
              control,
            ),
          )
          connection.capabilities = immutableData(
            initialized.agentCapabilities?.promptCapabilities ?? {},
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
                ...(options.profile === 'grok'
                  ? {
                      _meta: {
                        yoloMode: initialPolicy === 'yolo',
                        autoMode: false,
                      },
                    }
                  : {}),
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
      const cleanup = async () => {
        if (connection) {
          if (existing) await connection.retireProcess()
          else await connection.close()
        } else {
          if (created) await created.close()
          releaseProcess()
          if (existing) existing.candidate = undefined
          else await journal.close()
        }
      }
      try {
        await cleanup()
      } catch {
        throw new NativeCleanupError(cleanup)
      }
      throw error
    }
  }
}
