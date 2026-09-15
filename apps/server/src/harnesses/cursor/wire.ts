import { JsonlTransport } from '../jsonl.js'
import type { Readable, Writable } from 'node:stream'
import {
  CursorError,
  invariant,
  plainCopy,
  boundedId,
  type CursorLimits,
} from './limits.js'
export type CursorFrame = {
  v: 1
  generation: string
  type: string
  requestId?: string
  seq?: number
  [key: string]: unknown
}
const types = new Set([
  'initialize',
  'ready',
  'models',
  'models_result',
  'prepare',
  'prepared',
  'submit',
  'submitted',
  'cancel',
  'cancelled',
  'close',
  'closed',
  'event',
  'native_record',
  'result',
  'failure',
  'container_created',
  'container_bound',
  'retire',
  'retired',
  'bootstrap_wait',
])
const fields: Record<string, readonly string[]> = {
  initialize: [
    'identity',
    'node',
    'args',
    'entry',
    'cwd',
    'fence',
    'stateRoot',
    'limits',
    'removed',
    'probeData',
    'selected',
    'owner',
    'directory',
    'creating',
    'reservation',
  ],
  ready: ['readiness', 'pid', 'writerPid'],
  models: [],
  models_result: ['items'],
  prepare: [
    'owner',
    'reservationId',
    'digest',
    'model',
    'options',
    'agentId',
    'preparationMs',
  ],
  prepared: [
    'agentId',
    'initialQueuedRunId',
    'storeId',
    'owner',
    'reservationId',
  ],
  submit: ['owner', 'reservationId', 'message'],
  submitted: ['agentId', 'nativeRunId', 'owner'],
  cancel: [],
  cancelled: [],
  close: [],
  closed: [],
  event: ['owner', 'event'],
  native_record: ['owner', 'record'],
  result: ['owner', 'result'],
  failure: ['owner', 'code'],
  container_created: ['identity'],
  container_bound: [
    'nonce',
    'identity',
    'environment',
    'selected',
    'directory',
    'owner',
    'reservation',
    'limits',
    'discovery',
  ],
  retire: [],
  retired: ['identity', 'proof', 'pipesClosed'],
  bootstrap_wait: ['nonce', 'pid'],
}
const ownerFields = [
  'forgeSessionId',
  'provider',
  'accountId',
  'cwd',
  'storeId',
  'generation',
  'attemptId',
  'runId',
  'turnId',
] as const
export function validateOwner(value: unknown, limits: CursorLimits) {
  const owner = plainCopy(value, limits.markerBytes) as Record<string, unknown>
  invariant(
    owner && Object.keys(owner).length === ownerFields.length,
    'cursor_owner_shape',
  )
  for (const key of ownerFields)
    boundedId(owner[key], key === 'cwd' ? limits.argValueBytes : limits.idBytes)
  return owner
}
export function parseFrame(
  value: unknown,
  generation: string,
  limits: CursorLimits,
): CursorFrame {
  const frame = plainCopy(
    value,
    limits.frameBytes,
    limits.jsonDepth,
    limits.jsonElements,
  ) as CursorFrame
  invariant(
    frame &&
      frame.v === 1 &&
      frame.generation === generation &&
      types.has(frame.type),
    'cursor_wire_frame',
  )
  const allowed = new Set([
    'v',
    'generation',
    'type',
    'requestId',
    'seq',
    ...fields[frame.type],
  ])
  invariant(
    Object.keys(frame).every((key) => allowed.has(key)),
    'cursor_wire_field',
  )
  boundedId(frame.generation, limits.idBytes)
  if (
    !['event', 'native_record', 'result', 'failure', 'bootstrap_wait'].includes(
      frame.type,
    )
  )
    boundedId(frame.requestId, limits.requestIdBytes)
  if (frame.owner !== undefined) {
    const owner = validateOwner(frame.owner, limits)
    invariant(owner.generation === generation, 'cursor_owner_generation')
  }
  if (
    [
      'prepare',
      'prepared',
      'submit',
      'submitted',
      'event',
      'native_record',
      'result',
    ].includes(frame.type)
  )
    invariant(frame.owner, 'cursor_wire_owner')
  if (['prepare', 'prepared', 'submit'].includes(frame.type))
    boundedId(frame.reservationId, limits.idBytes)
  if (frame.type === 'prepare')
    invariant(
      (frame.preparationMs === undefined ||
        (typeof frame.preparationMs === 'number' &&
          Number.isFinite(frame.preparationMs) &&
          frame.preparationMs > 0 &&
          frame.preparationMs <= limits.preparationMs)) &&
        typeof frame.digest === 'string' &&
        /^[a-f0-9]{64}$/.test(frame.digest) &&
        frame.model &&
        frame.options,
      'cursor_wire_prepare',
    )
  if (frame.type === 'submit')
    invariant(
      frame.message && typeof frame.message === 'object',
      'cursor_wire_submit',
    )
  if (['prepared', 'submitted'].includes(frame.type))
    boundedId(frame.agentId, limits.idBytes)
  if (frame.type === 'prepared') {
    boundedId(frame.storeId, limits.idBytes)
    if (frame.initialQueuedRunId !== undefined)
      boundedId(frame.initialQueuedRunId, limits.idBytes)
  }
  if (frame.type === 'submitted') boundedId(frame.nativeRunId, limits.idBytes)
  if (frame.type === 'models_result')
    invariant(Array.isArray(frame.items), 'cursor_wire_catalog')
  if (frame.type === 'result')
    invariant(
      frame.result &&
        typeof frame.result === 'object' &&
        ['finished', 'cancelled', 'error'].includes(
          String((frame.result as Record<string, unknown>).status),
        ),
      'cursor_wire_result',
    )
  if (frame.type === 'failure') boundedId(frame.code, limits.messageBytes)
  if (frame.type === 'initialize')
    invariant(
      frame.identity ||
        (frame.selected && frame.owner && typeof frame.directory === 'string'),
      'cursor_wire_initialize',
    )
  if (frame.type === 'bootstrap_wait')
    invariant(
      typeof frame.nonce === 'string' &&
        Number.isSafeInteger(frame.pid) &&
        Number(frame.pid) > 0,
      'cursor_wire_bootstrap',
    )
  const maximum = ['submit', 'event', 'native_record', 'result'].includes(
    frame.type,
  )
    ? limits.frameBytes
    : frame.type === 'models_result'
      ? limits.catalogBytes
      : limits.controlBytes
  invariant(
    Buffer.byteLength(JSON.stringify(frame)) <= maximum,
    'cursor_wire_control_bytes',
  )
  if (frame.requestId !== undefined)
    boundedId(frame.requestId, limits.requestIdBytes)
  if (frame.seq !== undefined)
    invariant(
      Number.isSafeInteger(frame.seq) && frame.seq > 0,
      'cursor_wire_sequence',
    )
  return frame
}
export function cursorTransport(
  stdin: Writable,
  stdout: Readable,
  generation: string,
  limits: CursorLimits,
  onFrame: (frame: CursorFrame) => void,
  secrets: readonly string[] = [],
) {
  let sent = 0,
    received = 0,
    diagnosticPending = false
  const transport = new JsonlTransport({
    stdin,
    stdout,
    maxLineBytes: limits.frameBytes,
    maxQueuedBytes: limits.queuedWireBytes,
    maxQueuedFrames: limits.queuedFrames,
    secrets,
    validateOutgoing: (value) => {
      parseFrame(value, generation, limits)
    },
    onValue: (value) => {
      const frame = parseFrame(value, generation, limits)
      invariant(frame.seq === received + 1, 'cursor_wire_sequence')
      received++
      onFrame(frame)
    },
  })
  const send = transport.send.bind(transport)
  transport.send = (value) => {
    try {
      const captured = plainCopy(
          value,
          limits.frameBytes,
          limits.jsonDepth,
          limits.jsonElements,
        ) as CursorFrame,
        frame = parseFrame({ ...captured, seq: sent + 1 }, generation, limits),
        diagnostic = frame.type === 'failure',
        bytes = Buffer.byteLength(JSON.stringify(frame)) + 1,
        state = transport.state
      // One bounded terminal diagnostic fits even when ordinary output is blocked.
      invariant(
        diagnostic
          ? !diagnosticPending
          : state.queuedFrames < limits.queuedFrames - 1 &&
              state.queuedBytes + bytes <=
                limits.queuedWireBytes - limits.controlBytes,
        'cursor_wire_reserved_diagnostic',
      )
      sent++
      if (diagnostic) diagnosticPending = true
      return send(frame).finally(() => {
        if (diagnostic) diagnosticPending = false
      })
    } catch (error) {
      return Promise.reject(error)
    }
  }
  return transport
}
export class CursorWire {
  readonly transport: JsonlTransport
  private next = 0
  private pending = new Map<
    string,
    {
      type: string
      resolve: (frame: CursorFrame) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
      responded: boolean
      written: boolean
    }
  >()
  private retired = new Set<string>()
  constructor(
    stdin: Writable,
    stdout: Readable,
    readonly generation: string,
    private readonly limits: CursorLimits,
    readonly onFrame: (frame: CursorFrame) => void,
    secrets: readonly string[] = [],
  ) {
    this.transport = cursorTransport(
      stdin,
      stdout,
      generation,
      limits,
      (frame) => {
        const request = frame.requestId
          ? this.pending.get(frame.requestId)
          : undefined
        if (
          request &&
          !request.responded &&
          [
            'ready',
            'models_result',
            'prepared',
            'submitted',
            'cancelled',
            'closed',
            'retired',
            'failure',
            'container_created',
          ].includes(frame.type)
        ) {
          const expected: Record<string, string> = {
            initialize: 'container_created',
            container_bound: 'ready',
            models: 'models_result',
            prepare: 'prepared',
            submit: 'submitted',
            cancel: 'cancelled',
            close: 'closed',
            retire: 'retired',
          }
          invariant(
            frame.type === 'failure' ||
              frame.type === expected[request.type] ||
              (request.type === 'initialize' && frame.type === 'ready'),
            'cursor_wire_reply_type',
          )
          clearTimeout(request.timer)
          request.responded = true
          if (request.written) this.pending.delete(frame.requestId!)
          this.retired.add(frame.requestId!)
          if (frame.type === 'failure')
            request.reject(new CursorError(String(frame.code)))
          else request.resolve(frame)
        } else if (
          frame.requestId &&
          this.retired.has(frame.requestId) &&
          !(frame.type === 'failure' && frame.owner)
        )
          return
        else this.onFrame(frame)
      },
      secrets,
    )
    void this.transport.done.then((error) => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer)
        request.reject(error)
      }
      // EOF settles waiters, but does not prove nonabortable SDK work stopped.
      // The owning container releases these slots after physical retirement.
    })
  }
  releaseAfterRetirement() {
    invariant(this.transport.closed, 'cursor_wire_retirement_before_close')
    this.pending.clear()
  }
  async request(
    type: string,
    payload: Record<string, unknown> = {},
    timeout = this.limits.controlMs,
  ): Promise<CursorFrame> {
    const cleanup = ['cancel', 'close', 'retire'].includes(type)
    invariant(!this.transport.closed, 'cursor_wire_closed')
    invariant(
      this.pending.size < this.limits.controls - (cleanup ? 0 : 1),
      'cursor_control_limit',
    )
    invariant(
      this.next < this.limits.owners - (cleanup ? 0 : 3),
      'cursor_control_history_limit',
    )
    const requestId = String(++this.next)
    let resolve!: (frame: CursorFrame) => void, reject!: (error: Error) => void
    const result = new Promise<CursorFrame>((yes, no) => {
      resolve = yes
      reject = no
    })
    void result.catch(() => {})
    const timer = setTimeout(() => {
      this.retired.add(requestId)
      reject(new CursorError('cursor_control_timeout'))
    }, timeout)
    const physical = {
      type,
      resolve,
      reject,
      timer,
      responded: false,
      written: false,
    }
    this.pending.set(requestId, physical)
    try {
      void this.transport
        .send({
          v: 1,
          generation: this.generation,
          type,
          requestId,
          ...payload,
        })
        .then(() => {
          physical.written = true
          if (physical.responded) this.pending.delete(requestId)
        }, reject)
      return await result
    } catch (error) {
      clearTimeout(timer)
      this.retired.add(requestId)
      void result.catch(() => {})
      throw error
    }
  }
}
