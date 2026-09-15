import type {
  ConversationStep,
  InteractionUpdate,
  RunResult,
  SDKMessage,
} from '@cursor/sdk'
import type { HarnessEvent } from '../types.js'
import type { CursorNativeEnvelope, CursorOwner } from './contracts.js'
import {
  invariant,
  boundedId,
  CursorResources,
  plainCopy,
  type BoundedJson,
  type CursorLimits,
} from './limits.js'
type Item = { id: string; type: 'text' | 'thought' | 'tool'; text: string }
type Child = {
  id: string
  callId: string
  prompt: string
  providerId?: string
  observable: boolean
  finished: boolean
  item?: Item
}
type Task = {
  kind: 'spawn' | 'continuation' | 'observation' | 'unknown'
  prompt: string
  providerId?: string
}
type JsonObject = Record<string, any>

/** Content has a raw item ceiling. Its complete escaped record uses the frame budget. */
export function captureSdkValue<T>(value: T, limits: CursorLimits): T {
  const captured = plainCopy(
    value,
    limits.frameBytes - limits.controlBytes,
    limits.jsonDepth,
    limits.jsonElements,
  ) as T & JsonObject
  const text = (value: unknown) => {
    invariant(
      typeof value === 'string' && Buffer.byteLength(value) <= limits.itemBytes,
      'cursor_content_item_limit',
    )
  }
  switch (captured?.type) {
    case 'assistantMessage':
    case 'thinkingMessage':
      text(captured.message?.text)
      break
    case 'text-delta':
    case 'thinking-delta':
    case 'thinking':
      text(captured.text)
      break
    case 'tool-call-delta':
      captureSdkValue(captured.taskUpdate, limits)
      break
    case 'assistant':
    case 'user':
      invariant(
        Array.isArray(captured.message?.content),
        'cursor_content_shape',
      )
      for (const block of captured.message.content) {
        if (block.type === 'text') text(block.text)
        else
          plainCopy(
            block,
            limits.toolBytes,
            limits.jsonDepth,
            limits.jsonElements,
          )
      }
      break
    default:
      plainCopy(
        captured,
        limits.toolBytes,
        limits.jsonDepth,
        limits.jsonElements,
      )
  }
  return captured
}

/** Root step changes follow the pinned SDK conversation reducer, not callback timing. */
export class CursorNormalizer {
  private steps: Item[] = []
  private lastAssistant?: Item
  private latestUsage?: Record<string, number>
  private turn = 0
  private sequence = 0
  private started = false
  private sealed = false
  private children = new Map<string, Child>()
  private tasks = new Map<string, Task>()
  private tools = new Set<string>()
  private completedTools = new Set<string>()
  private ids = new Set<string>()
  private counts = new Map<string, { count: number; bytes: number }>()
  private contentBytes = 0
  private childBytes = 0
  private diagnostics = 0
  private diagnosticBytes = 0
  constructor(
    readonly owner: CursorOwner,
    private readonly limits: CursorLimits,
    private readonly event: (event: HarnessEvent) => void,
    private readonly native: (record: CursorNativeEnvelope) => void,
    private readonly resources = new CursorResources(),
  ) {}
  private retainId(id: string) {
    if (this.ids.has(id)) return
    const release = this.resources.charge(
      'nativeIdCount',
      1,
      this.limits.owners,
    )
    try {
      this.resources.charge(
        'nativeIdBytes',
        Buffer.byteLength(id),
        this.limits.ownerBytes,
      )
    } catch (error) {
      release()
      throw error
    }
    this.ids.add(id)
  }
  private envelope() {
    return {
      runId: this.owner.runId,
      turnId: this.owner.turnId,
      runtimeGeneration: this.owner.generation,
      deliveryId: `${this.owner.attemptId}:${++this.sequence}`,
    }
  }
  private charge(channel: string, value: unknown) {
    const bytes = Buffer.byteLength(JSON.stringify(value))
    const current = this.counts.get(channel) ?? { count: 0, bytes: 0 }
    invariant(
      current.count + 1 <= this.limits.rootEvents &&
        current.bytes + bytes <=
          (channel === 'events'
            ? this.limits.rootEventBytes
            : this.limits.rootInputBytes),
      'cursor_output_limit',
    )
    current.count++
    current.bytes += bytes
    this.counts.set(channel, current)
  }
  private emit(value: Record<string, unknown>) {
    const event = { ...this.envelope(), ...value } as HarnessEvent
    this.charge('events', event)
    this.event(event)
  }
  record(kind: CursorNativeEnvelope['kind'], payload: unknown) {
    const value = plainCopy(
      payload,
      kind === 'diagnostic'
        ? this.limits.detailBytes
        : kind === 'tool-record'
          ? this.limits.toolBytes
          : this.limits.frameBytes - this.limits.controlBytes,
      this.limits.jsonDepth,
      this.limits.jsonElements,
    ) as BoundedJson
    if (kind === 'diagnostic') {
      const bytes = Buffer.byteLength(JSON.stringify(value))
      invariant(
        this.diagnostics + 1 < this.limits.diagnostics &&
          this.diagnosticBytes + bytes + this.limits.messageBytes <=
            this.limits.diagnosticBytes,
        'cursor_diagnostic_limit',
      )
      this.diagnostics++
      this.diagnosticBytes += bytes
    }
    const envelope = this.envelope()
    const record: CursorNativeEnvelope = {
      v: 1,
      owner: this.owner,
      sourceSeq: this.sequence,
      deliveryId: envelope.deliveryId,
      kind,
      payload: value,
    }
    this.charge('events', record)
    this.native(record)
  }
  start() {
    if (!this.started) {
      this.started = true
      this.emit({ type: 'run_started' })
      this.emit({ type: 'turn_started' })
    }
  }
  private append(
    type: 'text' | 'thought',
    text: string,
    child?: Child,
    replace = false,
  ) {
    invariant(!this.sealed, 'cursor_late_content')
    let item = child ? child.item : this.steps.at(-1)
    if (!item || item.type !== type) {
      item = {
        id: `${this.owner.attemptId}:${child?.id ?? `root-${this.turn}`}:${child ? this.sequence : this.steps.length}`,
        type,
        text: '',
      }
      this.retainId(item.id)
      if (child) child.item = item
      else this.steps.push(item)
    }
    const previousBytes = Buffer.byteLength(item.text),
      nextBytes = Buffer.byteLength(text) + (replace ? 0 : previousBytes),
      difference = nextBytes - previousBytes
    invariant(nextBytes <= this.limits.itemBytes, 'cursor_content_item_limit')
    if (child) {
      invariant(
        this.childBytes + difference <= this.limits.childBytes,
        'cursor_child_content_limit',
      )
      this.childBytes += difference
    } else {
      invariant(
        this.contentBytes + difference <= this.limits.contentBytes,
        'cursor_content_limit',
      )
      this.contentBytes += difference
    }
    const next = replace ? text : item.text + text
    if (replace && next === item.text) return
    item.text = next
    if (!child && type === 'text') this.lastAssistant = item
    this.emit({
      type: replace
        ? 'content_snapshot'
        : type === 'text'
          ? 'text_delta'
          : 'thought_delta',
      itemId: item.id,
      ...(replace ? { contentType: type } : {}),
      text: replace ? next : text,
      ...(child ? { childId: child.id } : {}),
    })
  }
  step(step: ConversationStep) {
    const value = captureSdkValue(step, this.limits)
    this.charge('callbacks', value)
    this.start()
    if (this.sealed) {
      this.record('sdk-record', { source: 'lateStep', step: value })
      return
    }
    if (value.type === 'assistantMessage')
      this.append('text', value.message.text, undefined, true)
    else if (value.type === 'thinkingMessage')
      this.append('thought', value.message.text, undefined, true)
    this.record(value.type === 'toolCall' ? 'tool-record' : 'sdk-record', {
      source: 'onStep',
      step: value,
    })
  }
  delta(update: InteractionUpdate) {
    const value = captureSdkValue(update, this.limits) as JsonObject
    this.charge('callbacks', value)
    this.start()
    if (this.sealed) {
      this.record('sdk-record', { source: 'lateDelta', update: value })
      return
    }
    if (value.type === 'tool-call-delta') {
      const child = this.observeChild(value.callId)
      if (child) this.childDelta(child, value.taskUpdate)
      else
        this.record('diagnostic', {
          code: 'cursor_child_attribution_unavailable',
          callId: value.callId,
        })
      return
    }
    switch (value.type) {
      case 'user-message-appended':
        this.turn++
        this.steps = []
        break
      case 'text-delta':
        this.append('text', value.text)
        break
      case 'thinking-delta':
        this.append('thought', value.text)
        break
      case 'thinking-completed':
        this.record('sdk-record', {
          source: 'thinkingDuration',
          itemId: this.steps.at(-1)?.id ?? null,
          thinkingDurationMs: value.thinkingDurationMs,
        })
        break
      case 'tool-call-started':
      case 'partial-tool-call':
        this.tool(value, false)
        break
      case 'tool-call-completed':
        if (!this.completedTools.has(value.callId)) {
          this.tool(value, true)
          this.completedTools.add(value.callId)
          this.steps.push({
            id: `tool:${value.callId}`,
            type: 'tool',
            text: '',
          })
        }
        break
      case 'turn-ended':
        if (value.usage) this.usage(value.usage)
        break
      default:
        this.record('sdk-record', { source: 'onDelta', update: value })
    }
  }
  private classify(args: JsonObject): Task {
    const prompt = typeof args.prompt === 'string' ? args.prompt : ''
    const resume =
      typeof args.resume === 'string' && args.resume ? args.resume : undefined
    const agentId =
      typeof args.agentId === 'string' && args.agentId
        ? args.agentId
        : undefined
    if (resume && agentId && resume !== agentId)
      return { kind: 'unknown', prompt }
    const providerId = resume ?? agentId
    if (providerId) {
      boundedId(providerId, this.limits.idBytes)
      this.retainId(providerId)
    }
    return {
      kind: prompt.trim()
        ? providerId
          ? 'continuation'
          : 'spawn'
        : providerId
          ? 'observation'
          : 'unknown',
      prompt,
      providerId,
    }
  }
  private tool(update: JsonObject, complete: boolean) {
    const callId = update.callId
    invariant(
      typeof callId === 'string' &&
        Buffer.byteLength(callId) <= this.limits.idBytes,
      'cursor_tool_id',
    )
    const call = update.toolCall ?? {}
    if (!this.tools.has(callId)) {
      this.retainId(callId)
      this.retainId(`tool:${callId}`)
      invariant(this.tools.size < this.limits.owners, 'cursor_owner_limit')
      this.tools.add(callId)
      this.emit({
        type: 'tool_started',
        itemId: `tool:${callId}`,
        toolCallId: callId,
        name: call.type ?? 'unknown',
        input: call.args ?? null,
      })
    }
    if (
      call.type === 'task' &&
      update.type !== 'partial-tool-call' &&
      !this.tasks.has(callId)
    ) {
      const task = this.classify(call.args ?? {})
      const bytes =
        Buffer.byteLength(task.prompt) +
        Buffer.byteLength(task.providerId ?? '')
      invariant(
        this.childBytes + bytes <= this.limits.childBytes,
        'cursor_child_content_limit',
      )
      this.childBytes += bytes
      this.tasks.set(callId, task)
    }
    if (complete) {
      const result = call.result
      const failed =
        result?.status === 'error' ||
        (call.type === 'shell' && result?.value?.exitCode !== 0)
      this.emit({
        type: 'tool_update',
        itemId: `tool:${callId}`,
        toolCallId: callId,
        status: failed ? 'failed' : 'completed',
        output: result ?? null,
      })
      this.record('tool-record', { callId, toolCall: call })
      if (call.type === 'task') {
        const task = this.tasks.get(callId)
        const child =
          task &&
          task.kind !== 'observation' &&
          task.kind !== 'unknown' &&
          result?.status === 'success'
            ? this.observeChild(callId)
            : this.children.get(callId)
        if (child) {
          const nativeId = result?.value?.agentId
          if (typeof nativeId === 'string') {
            boundedId(nativeId, this.limits.idBytes)
            this.retainId(nativeId)
            child.providerId = nativeId
            this.emit({
              type: 'child_updated',
              itemId: child.id,
              childId: child.id,
              parentToolCallId: callId,
              providerChildId: nativeId,
            })
          }
          if (
            !child.finished &&
            result?.status === 'success' &&
            result.value?.isBackground === false
          )
            this.finishChild(child, { status: 'completed' })
          else if (!child.finished && result?.status === 'error')
            this.finishChild(child, {
              status: 'failed',
              code: 'cursor_child_native_error',
              message: 'Cursor child execution failed',
            })
        }
      }
      if (call.type === 'createPlan' && typeof call.args?.plan === 'string')
        this.emit({
          type: 'content_snapshot',
          contentType: 'plan',
          itemId: `plan:${callId}`,
          text: call.args.plan,
        })
      if (call.type === 'updateTodos' && Array.isArray(call.args?.todos))
        this.emit({
          type: 'plan',
          itemId: `plan:${callId}`,
          steps: call.args.todos.map((todo: JsonObject, index: number) => ({
            id: `${callId}:${index}`,
            title: todo.content,
            status:
              todo.status === 'inProgress'
                ? 'running'
                : todo.status === 'cancelled'
                  ? 'failed'
                  : todo.status,
          })),
        })
    }
  }
  private observeChild(callId: string) {
    const previous = this.children.get(callId)
    if (previous) return previous
    const task = this.tasks.get(callId)
    if (!task || task.kind === 'observation' || task.kind === 'unknown')
      return undefined
    invariant(
      this.children.size < this.limits.children &&
        [...this.children.values()].filter((child) => !child.finished).length <
          this.limits.liveChildren,
      'cursor_children_limit',
    )
    const child: Child = {
      id: `${this.owner.attemptId}:child:${callId}`,
      callId,
      prompt: task.prompt,
      providerId: task.providerId,
      observable: true,
      finished: false,
    }
    this.retainId(child.id)
    this.children.set(callId, child)
    this.emit({
      type: 'child_started',
      itemId: child.id,
      childId: child.id,
      parentToolCallId: callId,
      description: task.prompt,
      ...(child.providerId ? { providerChildId: child.providerId } : {}),
    })
    return child
  }
  private childDelta(child: Child, update: JsonObject) {
    if (this.sealed || child.finished) {
      this.record('sdk-record', {
        source: 'lateChildObservation',
        childId: child.id,
        update,
      })
      return
    }
    if (update?.type === 'text-delta') this.append('text', update.text, child)
    else if (update?.type === 'thinking-delta')
      this.append('thought', update.text, child)
    else
      this.record('sdk-record', {
        source: 'childObservation',
        childId: child.id,
        update,
      })
  }
  private finishChild(child: Child, outcome: unknown) {
    if (child.finished) return
    child.finished = true
    this.emit({
      type: 'child_finished',
      itemId: child.id,
      childId: child.id,
      outcome,
    })
  }
  stream(message: SDKMessage) {
    const value = captureSdkValue(message, this.limits) as JsonObject
    this.charge('stream', value)
    if (value.type === 'task')
      this.record('summary', { source: 'stream', message: value })
    else if (['status', 'request', 'system'].includes(value.type))
      this.record('sdk-record', { source: 'stream', message: value })
  }
  private usage(value: JsonObject, cumulative = false) {
    const {
      inputTokens,
      outputTokens,
      cacheReadTokens = 0,
      cacheWriteTokens = 0,
      reasoningTokens,
    } = value
    if (
      ![inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].every(
        (count) => Number.isSafeInteger(count) && count >= 0,
      )
    )
      return
    if (
      reasoningTokens !== undefined &&
      (!Number.isSafeInteger(reasoningTokens) || reasoningTokens < 0)
    )
      return
    const counts = {
      inputTokens,
      outputTokens,
      cachedInputTokens: cacheReadTokens,
      cacheWriteInputTokens: cacheWriteTokens,
      totalTokens:
        inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
      ...(reasoningTokens === undefined
        ? {}
        : { reasoningOutputTokens: reasoningTokens }),
    }
    if (!cumulative) this.latestUsage = counts
    // Final totals do not describe a call. Without a call snapshot, retain
    // those totals in the native terminal record only.
    if (!this.latestUsage) return
    this.emit({
      type: 'usage',
      itemId: `${this.owner.attemptId}:usage`,
      ...this.latestUsage,
      ...(cumulative ? { cumulative: counts } : {}),
    })
  }
  finish(result: RunResult) {
    this.start()
    if (Object.hasOwn(result, 'result') && typeof result.result === 'string') {
      const last = this.lastAssistant
      if (last) {
        const current = this.steps.at(-1)
        this.steps.push(last)
        this.append('text', result.result, undefined, true)
        this.steps.pop()
        if (current && this.steps.at(-1) !== current)
          invariant(false, 'cursor_content_order')
      } else if (result.result.length)
        this.append('text', result.result, undefined, true)
    }
    if (result.usage) this.usage(result.usage, true)
    for (const child of this.children.values())
      if (!child.finished)
        this.finishChild(child, {
          status: 'failed',
          code: 'cursor_child_outcome_unavailable',
          message: 'Cursor child outcome is unavailable',
        })
    this.record('terminal', result)
    this.sealed = true
  }
}
