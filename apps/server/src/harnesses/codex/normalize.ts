import { z } from 'zod'
import {
  harnessEventSchema,
  type HarnessEvent,
  type TerminalOutcome,
} from '@forge/protocol/harness'
import { byteTail, redactSecrets } from '../diagnostics.js'
import {
  CodexBudget,
  MiB,
  byteSize,
  fail,
  idSchema,
  nativeItemSchema,
  pathSchema,
  record,
  tupleId,
  type NativeItem,
  type NativeTurn,
} from './wire.js'
import type { CodexOwner } from './requests.js'

const contentLimit = 4 * MiB
const toolPartialLimit = 16 * MiB
const toolPublicationLimit = 32 * MiB
const indexSchema = z.number().int().min(0).max(127)
type ItemState = {
  id: string
  type: string
  role?: 'user' | 'assistant'
  final: boolean
  parts: { summary: Set<number>; content: Set<number> }
  toolStarted: boolean
  toolPublished: number
  toolDigest?: string
  snapshots: Map<
    string,
    { text: string; metadata: Record<string, string>; final: boolean }
  >
  retainedBytes: number
  resize: (bytes: number) => void
  release: () => void
}
type Stream = {
  text: string
  bytes: number
  next: number
  emitted: number
  release: () => void
}
export function terminalOutcome(
  turn: NativeTurn,
  secrets: readonly string[] = [],
): TerminalOutcome | undefined {
  if (turn.status === 'inProgress') return undefined
  if (turn.status === 'completed') return { status: 'completed' }
  if (turn.status === 'interrupted') return { status: 'interrupted' }
  return {
    status: 'failed',
    code: 'CODEX_TURN_FAILED',
    message: byteTail(
      redactSecrets(turn.error?.message ?? 'Codex turn failed', secrets),
      4096,
    ),
  }
}

/** One mapper for live final items, embedded full turns, and explicit history import. */
export class CodexNormalizer {
  private sequence = 0
  private readonly items = new Map<string, ItemState>()
  private readonly streams = new Map<string, Stream>()
  private readonly partReleases: (() => void)[] = []
  private liveBytes = 0
  constructor(
    readonly runtimeGeneration: string,
    private readonly publish: (event: HarnessEvent) => void,
    private readonly budget: CodexBudget,
    private readonly secrets: readonly string[] = [],
  ) {}
  get state() {
    return {
      items: this.items.size,
      streams: this.streams.size,
      liveBytes: this.liveBytes,
    }
  }
  emit = (
    owner: CodexOwner,
    nativeItemId: string,
    event: Record<string, unknown>,
  ) => {
    idSchema.parse(nativeItemId)
    const envelope = {
      runId: owner.runId,
      turnId: owner.turnId,
      runtimeGeneration: this.runtimeGeneration,
      deliveryId: `${this.runtimeGeneration}:${++this.sequence}`,
      providerRunId: owner.nativeThreadId,
      providerTurnId: owner.nativeTurnId,
      providerItemId: nativeItemId,
      itemId: tupleId(owner.nativeThreadId, owner.nativeTurnId, nativeItemId),
      ...(owner.childId ? { childId: owner.childId } : {}),
    }
    this.publish(harnessEventSchema.parse({ ...envelope, ...event }))
  }
  lifecycle(
    owner: CodexOwner,
    type:
      | 'run_started'
      | 'turn_started'
      | 'turn_completed'
      | 'prompt_accepted'
      | 'steer_accepted'
      | 'run_failed',
    extra: Record<string, unknown> = {},
  ) {
    this.publish(
      harnessEventSchema.parse({
        type,
        runId: owner.runId,
        turnId: owner.turnId,
        runtimeGeneration: this.runtimeGeneration,
        deliveryId: `${this.runtimeGeneration}:${++this.sequence}`,
        providerRunId: owner.nativeThreadId,
        providerTurnId: owner.nativeTurnId,
        ...extra,
      }),
    )
  }
  diagnostic(
    owner: CodexOwner,
    itemId: string,
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    this.emit(owner, itemId, {
      type: 'diagnostic',
      code: byteTail(redactSecrets(code, this.secrets), 256),
      message: byteTail(redactSecrets(message, this.secrets), 4096),
      severity: 'error',
      ...extra,
    })
  }
  private itemState(
    owner: CodexOwner,
    id: string,
    type: string,
    role?: 'user' | 'assistant',
  ) {
    idSchema.parse(id)
    const key = tupleId(owner.nativeThreadId, owner.nativeTurnId, id)
    let state = this.items.get(key)
    if (!state) {
      const retainedBytes =
        byteSize([owner.nativeThreadId, owner.nativeTurnId, id, key, type]) +
        384
      const release = this.budget.charge(
        'items',
        retainedBytes,
        32768,
        12 * MiB,
      )
      state = {
        id: key,
        type,
        role,
        final: false,
        parts: { summary: new Set(), content: new Set() },
        toolStarted: false,
        toolPublished: 0,
        snapshots: new Map(),
        retainedBytes,
        resize: release.resize,
        release,
      }
      this.items.set(key, state)
    } else if (
      state.type !== type ||
      (role !== undefined && state.role !== role)
    )
      fail('ITEM_IDENTITY')
    return state
  }
  private streamKey(state: ItemState, channel: string, part = 0) {
    return tupleId(state.id, channel, part)
  }
  private stream(state: ItemState, channel: string, part = 0) {
    if (state.final) fail('FINALIZED_STREAM')
    const key = this.streamKey(state, channel, part)
    let stream = this.streams.get(key)
    if (!stream) {
      const release = this.budget.charge(
        'streams',
        byteSize(key) + 128,
        4096,
        MiB,
      )
      stream = { text: '', bytes: 0, next: 1024, emitted: 0, release }
      this.streams.set(key, stream)
    }
    return stream
  }
  private append(stream: Stream, delta: string, limit = contentLimit) {
    const bytes = byteSize(delta)
    if (bytes + stream.bytes > limit) fail('CONTENT_LIMIT')
    if (this.liveBytes + bytes > 32 * MiB) fail('LIVE_CONTENT_LIMIT')
    stream.text += delta
    stream.bytes += bytes
    this.liveBytes += bytes
  }
  private releaseStream(state: ItemState, channel: string, part = 0) {
    const key = this.streamKey(state, channel, part)
    const stream = this.streams.get(key)
    if (stream) {
      this.streams.delete(key)
      this.liveBytes -= stream.bytes
      stream.release()
    }
  }
  private part(state: ItemState, channel: 'summary' | 'content', part: number) {
    indexSchema.parse(part)
    if (!state.parts[channel].has(part)) {
      const release = this.budget.charge(
        'reasoning-parts',
        byteSize([state.id, channel, part]),
        4096,
        MiB,
      )
      state.parts[channel].add(part)
      this.partReleases.push(release)
    }
  }
  private snapshot(
    owner: CodexOwner,
    id: string,
    state: ItemState,
    contentType: 'text' | 'thought' | 'plan',
    text: string,
    metadata: Record<string, unknown> = {},
    channel: string = contentType,
    part = 0,
    final = true,
  ) {
    if (byteSize(text) > contentLimit) fail('CONTENT_LIMIT')
    const itemId =
      contentType === 'thought' ? tupleId(state.id, channel, part) : state.id
    const event = {
      type: 'content_snapshot',
      contentType,
      itemId,
      text,
      ...metadata,
    }
    const key = this.streamKey(state, channel, part)
    const previous = state.snapshots.get(key)
    const effectiveMetadata = { ...previous?.metadata }
    for (const [name, value] of Object.entries(metadata))
      if (value !== undefined)
        effectiveMetadata[name] = tupleId(JSON.stringify(value))
    const snapshot = { text: tupleId(text), metadata: effectiveMetadata, final }
    if (
      previous?.final &&
      final &&
      previous.text === snapshot.text &&
      JSON.stringify(previous.metadata) === JSON.stringify(effectiveMetadata)
    )
      return
    const previousBytes = state.retainedBytes + byteSize([...state.snapshots])
    const next = new Map(state.snapshots)
    next.set(key, snapshot)
    state.resize(state.retainedBytes + byteSize([...next]))
    try {
      this.emit(owner, id, event)
    } catch (error) {
      state.resize(previousBytes)
      throw error
    }
    state.snapshots = next
    if (final) this.releaseStream(state, channel, part)
  }
  item(owner: CodexOwner, value: unknown, final: boolean) {
    const parsed = nativeItemSchema.parse(value)
    const id = parsed.id
    const type = parsed.type
    if (type === 'agentMessage') {
      const data = z
        .object({
          text: z.string(),
          phase: z.enum(['commentary', 'final_answer']).nullish(),
          delivery: z.literal('async').nullish(),
          questions: z.unknown().optional(),
        })
        .parse(parsed)
      const state = this.itemState(owner, id, type, 'assistant')
      const metadata = Object.fromEntries(
        ['phase', 'delivery', 'questions']
          .filter((key) => Object.hasOwn(parsed, key))
          .map((key) => [key, parsed[key]]),
      )
      if (final) {
        this.snapshot(owner, id, state, 'text', data.text, metadata)
        state.final = true
      } else if (!state.final) {
        const existing = this.streams.get(this.streamKey(state, 'text'))
        const stream = this.stream(state, 'text')
        if (!existing) this.append(stream, data.text)
        this.snapshot(
          owner,
          id,
          state,
          'text',
          stream.text,
          metadata,
          'text',
          0,
          false,
        )
      }
      return
    }
    if (type === 'userMessage') {
      const data = z
        .object({
          content: z
            .array(
              z
                .object({ type: z.string(), text: z.string().optional() })
                .catchall(z.unknown()),
            )
            .max(128),
          clientId: idSchema.nullish(),
        })
        .parse(parsed)
      if (!owner.childId) return
      const state = this.itemState(owner, id, type, 'user')
      if (final) {
        this.snapshot(
          owner,
          id,
          state,
          'text',
          data.content
            .filter((input) => input.type === 'text')
            .map((input) => input.text ?? '')
            .join('\n'),
          { role: 'user' },
        )
        state.final = true
      }
      return
    }
    if (type === 'plan') {
      const data = z.object({ text: z.string() }).parse(parsed)
      const state = this.itemState(owner, id, type)
      if (final) {
        this.snapshot(owner, id, state, 'plan', data.text)
        state.final = true
      }
      return
    }
    if (type === 'reasoning') {
      const data = z
        .object({
          summary: z.array(z.string()).max(128).optional(),
          content: z.array(z.string()).max(128).optional(),
        })
        .parse(parsed)
      const state = this.itemState(owner, id, type)
      if (final) {
        for (const channel of ['summary', 'content'] as const) {
          const values = data[channel] ?? []
          for (let part = 0; part < values.length; part++) {
            this.part(state, channel, part)
            this.snapshot(
              owner,
              id,
              state,
              'thought',
              values[part]!,
              {},
              channel,
              part,
            )
          }
          for (const part of state.parts[channel])
            if (part >= values.length)
              this.snapshot(owner, id, state, 'thought', '', {}, channel, part)
        }
        state.final = true
      }
      return
    }
    this.tool(owner, parsed, final)
  }
  private tool(owner: CodexOwner, item: NativeItem, final: boolean) {
    const supported = [
      'commandExecution',
      'fileChange',
      'mcpToolCall',
      'dynamicToolCall',
      'functionCallOutput',
      'collabAgentToolCall',
      'subAgentActivity',
      'webSearch',
      'imageView',
      'imageGeneration',
      'sleep',
      'enteredReviewMode',
      'exitedReviewMode',
      'contextCompaction',
      'hookPrompt',
    ]
    if (!supported.includes(item.type)) {
      this.diagnostic(
        owner,
        item.id,
        'CODEX_ITEM_UNSUPPORTED',
        'Codex item type is unsupported',
        { severity: 'warning' },
      )
      return
    }
    if (byteSize(item) > 8 * MiB) fail('TOOL_LIMIT')
    if (item.type === 'commandExecution')
      z.object({
        command: z.string(),
        commandActions: z.array(z.unknown()),
        cwd: pathSchema,
        status: z.enum(['inProgress', 'completed', 'failed', 'declined']),
      }).parse(item)
    if (item.type === 'fileChange')
      z.object({
        changes: z.array(
          z.object({
            path: pathSchema,
            kind: z
              .object({ type: z.enum(['add', 'delete', 'update']) })
              .catchall(z.unknown()),
            diff: z.string(),
          }),
        ),
        status: z.enum(['inProgress', 'completed', 'failed', 'declined']),
      }).parse(item)
    if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
      if (!Object.hasOwn(item, 'arguments')) fail('TOOL_ARGUMENTS')
      z.object({
        tool: idSchema,
        status: z.enum(['inProgress', 'completed', 'failed']),
        ...(item.type === 'mcpToolCall' ? { server: idSchema } : {}),
      }).parse(item)
    }
    if (item.type === 'functionCallOutput')
      z.object({
        name: idSchema,
        output: z.union([z.string(), z.array(z.unknown())]),
      }).parse(item)
    if (item.type === 'collabAgentToolCall')
      z.object({
        senderThreadId: idSchema,
        receiverThreadIds: z.array(idSchema).max(2048),
        agentsStates: z.record(
          idSchema,
          z.object({ status: z.string() }).catchall(z.unknown()),
        ),
        status: z.enum(['inProgress', 'completed', 'failed', 'interrupted']),
        tool: z.enum([
          'spawnAgent',
          'sendInput',
          'resumeAgent',
          'wait',
          'closeAgent',
          'sendMessage',
          'followupTask',
          'interruptAgent',
          'listAgents',
        ]),
      }).parse(item)
    if (item.type === 'subAgentActivity')
      z.object({
        agentThreadId: idSchema,
        agentPath: pathSchema,
        kind: z.enum(['started', 'interacted', 'interrupted', 'completed']),
      }).parse(item)
    if (item.type === 'webSearch') z.object({ query: z.string() }).parse(item)
    if (item.type === 'imageView') z.object({ path: pathSchema }).parse(item)
    if (item.type === 'sleep')
      z.object({ durationMs: z.number().int().nonnegative() }).parse(item)
    if (item.type === 'imageGeneration')
      z.object({ result: z.string(), status: z.string() }).parse(item)
    if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode')
      z.object({ review: z.string() }).parse(item)
    if (item.type === 'hookPrompt')
      z.object({
        fragments: z.array(z.object({ hookRunId: idSchema, text: z.string() })),
      }).parse(item)
    const state = this.itemState(owner, item.id, item.type)
    const command = item.type === 'commandExecution'
    const digest = command ? tupleId(JSON.stringify(item)) : undefined
    if (command && final && state.final && state.toolDigest === digest) return
    // The first frame publishes the item as both tool input and aggregate output.
    const publishedBytes = byteSize(item) * (state.toolStarted ? 1 : 2)
    // Reserve one full final output. Later corrections fail visibly at the total ceiling.
    if (
      command &&
      state.toolPublished + publishedBytes >
        toolPublicationLimit - (final ? 0 : 8 * MiB)
    )
      fail('TOOL_PUBLICATION_LIMIT')
    const toolCallId = tupleId(
      owner.nativeThreadId,
      owner.nativeTurnId,
      item.id,
      'tool',
    )
    if (!state.toolStarted) {
      state.toolStarted = true
      this.emit(owner, item.id, {
        type: 'tool_started',
        toolCallId,
        name: typeof item.tool === 'string' ? item.tool : item.type,
        input: item,
      })
    }
    this.emit(owner, item.id, {
      type: 'tool_update',
      toolCallId,
      status:
        typeof item.status === 'string'
          ? item.status
          : final
            ? 'completed'
            : 'inProgress',
      output: item,
    })
    if (command) {
      state.toolPublished += publishedBytes
      state.toolDigest = digest
    }
    if (item.type === 'fileChange')
      for (const change of item.changes as {
        path: string
        kind: { type: 'add' | 'delete' | 'update'; move_path?: string | null }
      }[])
        this.emit(owner, item.id, {
          type: 'file_change',
          path: change.path,
          kind: (
            { add: 'created', delete: 'deleted', update: 'modified' } as const
          )[change.kind.type],
        })
    if (final) {
      this.releaseStream(state, 'tool')
      state.final = true
    }
  }
  turn(owner: CodexOwner, turn: NativeTurn) {
    if (turn.itemsView === undefined || turn.itemsView === 'full')
      for (const item of turn.items) this.item(owner, item, true)
  }
  notification(
    owner: CodexOwner,
    method: string,
    params: Record<string, unknown>,
  ) {
    if (method === 'item/started' || method === 'item/completed') {
      this.item(owner, params.item, method === 'item/completed')
      return
    }
    if (
      method === 'item/agentMessage/delta' ||
      method === 'item/plan/delta' ||
      method === 'item/reasoning/summaryTextDelta' ||
      method === 'item/reasoning/textDelta' ||
      method === 'item/reasoning/summaryPartAdded'
    ) {
      const id = idSchema.parse(params.itemId)
      const reasoning = method.includes('/reasoning/')
      const plan = method === 'item/plan/delta'
      const channel = reasoning
        ? method.includes('summary')
          ? 'summary'
          : 'content'
        : plan
          ? 'plan'
          : 'text'
      const part = reasoning
        ? indexSchema.parse(
            channel === 'summary' ? params.summaryIndex : params.contentIndex,
          )
        : 0
      const state = this.itemState(
        owner,
        id,
        reasoning ? 'reasoning' : plan ? 'plan' : 'agentMessage',
        reasoning || plan ? undefined : 'assistant',
      )
      if (reasoning) this.part(state, channel as 'summary' | 'content', part)
      const stream = this.stream(state, channel, part)
      if (method.endsWith('summaryPartAdded')) return
      const delta = z.string().parse(params.delta)
      this.append(stream, delta)
      if (plan) {
        if (stream.bytes >= stream.next) {
          while (stream.next <= stream.bytes) stream.next *= 2
          if (stream.emitted + stream.bytes <= 8 * MiB) {
            this.emit(owner, id, {
              type: 'content_snapshot',
              contentType: 'plan',
              text: stream.text,
            })
            stream.emitted += stream.bytes
          }
        }
      } else
        this.emit(owner, id, {
          type: reasoning ? 'thought_delta' : 'text_delta',
          itemId: reasoning ? tupleId(state.id, channel, part) : state.id,
          text: delta,
        })
      return
    }
    if (method === 'item/commandExecution/outputDelta') {
      const id = idSchema.parse(params.itemId)
      const state = this.itemState(owner, id, 'commandExecution')
      const stream = this.stream(state, 'tool')
      this.append(stream, z.string().parse(params.delta), 8 * MiB)
      if (stream.bytes < stream.next) return
      while (stream.next <= stream.bytes) stream.next *= 2
      const output = { aggregatedOutput: stream.text }
      const publishedBytes = byteSize(output)
      if (
        stream.emitted + publishedBytes > toolPartialLimit ||
        state.toolPublished + publishedBytes > toolPublicationLimit - 8 * MiB
      )
        return
      this.emit(owner, id, {
        type: 'tool_update',
        toolCallId: tupleId(
          owner.nativeThreadId,
          owner.nativeTurnId,
          id,
          'tool',
        ),
        status: 'inProgress',
        output,
      })
      stream.emitted += publishedBytes
      state.toolPublished += publishedBytes
      return
    }
    if (method === 'turn/plan/updated') {
      const data = z
        .object({
          explanation: z.string().nullish(),
          plan: z
            .array(
              z.object({
                step: z.string(),
                status: z.enum(['pending', 'inProgress', 'completed']),
              }),
            )
            .max(4096),
        })
        .parse(params)
      this.emit(owner, 'plan-progress', {
        type: 'plan',
        ...(Object.hasOwn(data, 'explanation')
          ? { explanation: data.explanation }
          : {}),
        steps: data.plan.map((step, i) => ({
          id: tupleId(
            owner.nativeThreadId,
            owner.nativeTurnId,
            'plan-progress',
            i,
          ),
          title: step.step,
          status: step.status === 'inProgress' ? 'running' : step.status,
        })),
      })
      return
    }
    if (method === 'thread/tokenUsage/updated') {
      const counts = z.object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        totalTokens: z.number().int().nonnegative(),
        cachedInputTokens: z.number().int().nonnegative().optional(),
        cacheWriteInputTokens: z.number().int().nonnegative().optional(),
        reasoningOutputTokens: z.number().int().nonnegative().optional(),
      })
      const data = z
        .object({
          last: counts,
          total: counts,
          modelContextWindow: z.number().int().nonnegative().nullish(),
        })
        .parse(params.tokenUsage)
      this.emit(owner, 'usage', {
        type: 'usage',
        ...data.last,
        cumulative: data.total,
        ...(Object.hasOwn(data, 'modelContextWindow')
          ? { modelContextWindow: data.modelContextWindow }
          : {}),
      })
      return
    }
    if (method === 'error') {
      const data = z
        .object({
          error: z.object({
            message: z.string(),
            codexErrorInfo: z.unknown().optional(),
            additionalDetails: z.string().nullish(),
          }),
          willRetry: z.boolean(),
        })
        .parse(params)
      const info = data.error.codexErrorInfo
      let code = 'CODEX_NATIVE_ERROR'
      let httpStatus: unknown = undefined
      if (typeof info === 'string') code = info
      else if (record(info)) {
        code = Object.keys(info)[0] ?? code
        const detail = info[code]
        if (record(detail) && Object.hasOwn(detail, 'httpStatusCode'))
          httpStatus = detail.httpStatusCode
      }
      this.diagnostic(owner, 'error', code, data.error.message, {
        retryable: data.willRetry,
        ...(httpStatus === undefined ? {} : { httpStatus }),
        ...(Object.hasOwn(data.error, 'additionalDetails')
          ? {
              details:
                data.error.additionalDetails == null
                  ? data.error.additionalDetails
                  : byteTail(
                      redactSecrets(data.error.additionalDetails, this.secrets),
                      16 * 1024,
                    ),
            }
          : {}),
      })
      return
    }
    if (
      [
        'turn/diff/updated',
        'item/fileChange/outputDelta',
        'item/commandExecution/terminalInteraction',
        'item/mcpToolCall/progress',
      ].includes(method)
    ) {
      if (byteSize(params) > 8 * MiB) fail('TOOL_LIMIT')
      const id =
        params.itemId == null ? 'turn-diff' : idSchema.parse(params.itemId)
      this.emit(owner, id, {
        type: 'tool_update',
        toolCallId: tupleId(
          owner.nativeThreadId,
          owner.nativeTurnId,
          id,
          'tool',
        ),
        status: 'inProgress',
        output: params,
      })
    }
  }
  close() {
    for (const stream of this.streams.values()) stream.release()
    this.streams.clear()
    this.liveBytes = 0
    for (const item of this.items.values()) item.release()
    this.items.clear()
    for (const release of this.partReleases) release()
    this.partReleases.length = 0
  }
}
