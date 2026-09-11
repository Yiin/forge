import { z } from 'zod'
import type { HarnessEvent } from '../types.js'
import { redactSecrets as redact } from '../diagnostics.js'
import {
  bytes,
  count,
  fail,
  freeze,
  id,
  inert,
  MiB,
  text,
  type PiLimits,
} from './wire.js'
import { imageMime, type PiImageRef } from './input.js'

const textBlock = z.strictObject({
  type: z.literal('text'),
  text: text(4 * MiB),
  textSignature: text(4 * MiB).optional(),
})
const thoughtBlock = z.strictObject({
  type: z.literal('thinking'),
  thinking: text(4 * MiB),
  thinkingSignature: text(4 * MiB).optional(),
  redacted: z.boolean().optional(),
})
const imageBlock = z.strictObject({
  type: z.literal('image'),
  mimeType: imageMime,
  data: text(14 * MiB),
})
const imageRef = z.strictObject({
  type: z.literal('image'),
  mimeType: imageMime,
  attachmentId: id,
  sizeBytes: count.max(10 * MiB),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
export const toolCall = z.strictObject({
  type: z.literal('toolCall'),
  id,
  name: text(),
  arguments: z.record(z.string(), inert),
  thoughtSignature: text(4 * MiB).optional(),
})
export const usageSchema = z.strictObject({
  input: count,
  output: count,
  cacheRead: count.optional(),
  cacheWrite: count.optional(),
  cacheWrite1h: count.optional(),
  reasoning: count.optional(),
  totalTokens: count,
  cost: z
    .strictObject({
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      cacheRead: z.number().nonnegative(),
      cacheWrite: z.number().nonnegative(),
      total: z.number().nonnegative(),
    })
    .optional(),
})
const toolResultSchema = z.strictObject({
  content: z.array(z.union([textBlock, imageBlock])).max(256),
  details: inert.optional(),
  usage: usageSchema.optional(),
  addedToolNames: z.array(text()).max(1024).optional(),
  terminate: z.boolean().optional(),
})
const content = z.union([
  z.string().max(4 * MiB),
  z.array(z.union([textBlock, imageBlock, imageRef])).max(256),
])
const common = { timestamp: z.number().finite(), id: id.optional() }
export const messageSchema = z.discriminatedUnion('role', [
  z.strictObject({ ...common, role: z.literal('user'), content }),
  z.strictObject({
    ...common,
    role: z.literal('assistant'),
    content: z.array(z.union([textBlock, thoughtBlock, toolCall])).max(256),
    api: text(),
    provider: text(),
    model: text(),
    responseModel: text().optional(),
    responseId: text().optional(),
    usage: usageSchema,
    stopReason: z.enum([
      'pending',
      'stop',
      'length',
      'toolUse',
      'error',
      'aborted',
      'deferred',
    ]),
    errorMessage: text().optional(),
    rawStopReason: text().optional(),
    diagnostics: z
      .array(
        z.strictObject({
          type: text(256),
          timestamp: z.number().finite(),
          error: z
            .strictObject({
              name: text().optional(),
              message: text(),
              stack: text().optional(),
              code: z.union([text(), z.number().finite()]).optional(),
            })
            .optional(),
          details: inert.optional(),
        }),
      )
      .max(128)
      .optional(),
    deferred: z
      .strictObject({
        provider: text(),
        modelId: text(),
        api: text(),
        id: text(),
        expiresAt: count.optional(),
        pollAfterMs: count.optional(),
        data: inert.optional(),
      })
      .optional(),
  }),
  z.strictObject({
    ...common,
    role: z.literal('toolResult'),
    toolCallId: id,
    toolName: text(),
    content: z.array(z.union([textBlock, imageBlock, imageRef])).max(256),
    details: inert.optional(),
    usage: usageSchema.optional(),
    addedToolNames: z.array(text()).max(1024).optional(),
    isError: z.boolean(),
  }),
  z.strictObject({
    ...common,
    role: z.literal('custom'),
    customType: text(),
    content,
    display: z.boolean(),
    details: inert.optional(),
  }),
  z.strictObject({
    ...common,
    role: z.literal('bashExecution'),
    command: text(4 * MiB),
    output: text(4 * MiB),
    exitCode: z.number().int().optional(),
    cancelled: z.boolean(),
    truncated: z.boolean(),
    fullOutputPath: text().optional(),
    excludeFromContext: z.boolean().optional(),
  }),
  z.strictObject({
    ...common,
    role: z.literal('compactionSummary'),
    summary: text(4 * MiB),
    tokensBefore: count,
  }),
  z.strictObject({
    ...common,
    role: z.literal('branchSummary'),
    summary: text(4 * MiB),
    fromId: id,
  }),
])
export type PiMessage = z.infer<typeof messageSchema>
export type PiContentImage = PiImageRef
export const uiRequestSchema = z.discriminatedUnion('method', [
  z.strictObject({
    type: z.literal('extension_ui_request'),
    id,
    method: z.literal('select'),
    title: text(),
    options: z.array(text()).max(128),
    timeout: z.number().finite().optional(),
  }),
  z.strictObject({
    type: z.literal('extension_ui_request'),
    id,
    method: z.literal('confirm'),
    title: text(),
    message: text(),
    timeout: z.number().finite().optional(),
  }),
  z.strictObject({
    type: z.literal('extension_ui_request'),
    id,
    method: z.literal('input'),
    title: text(),
    placeholder: text().optional(),
    timeout: z.number().finite().optional(),
  }),
  z.strictObject({
    type: z.literal('extension_ui_request'),
    id,
    method: z.literal('editor'),
    title: text(),
    prefill: text().optional(),
  }),
])
export const uiResponseSchema = z.union([
  z.strictObject({
    type: z.literal('extension_ui_response'),
    id,
    value: text(),
  }),
  z.strictObject({
    type: z.literal('extension_ui_response'),
    id,
    confirmed: z.boolean(),
  }),
  z.strictObject({
    type: z.literal('extension_ui_response'),
    id,
    cancelled: z.literal(true),
  }),
])
export const uiMetadataSchema = z.discriminatedUnion('method', [
  z.strictObject({
    type: z.literal('extension_ui_request'),
    id,
    method: z.literal('notify'),
    message: text(),
    notifyType: z.enum(['info', 'warning', 'error']).optional(),
  }),
  z.strictObject({
    type: z.literal('extension_ui_request'),
    id,
    method: z.literal('setStatus'),
    statusKey: id,
    statusText: text().optional(),
  }),
  z.strictObject({
    type: z.literal('extension_ui_request'),
    id,
    method: z.literal('setWidget'),
    widgetKey: id,
    widgetLines: z.array(text()).max(128).optional(),
    widgetPlacement: z.enum(['aboveEditor', 'belowEditor']).optional(),
  }),
  z.strictObject({
    type: z.literal('extension_ui_request'),
    id,
    method: z.literal('setTitle'),
    title: text(),
  }),
  z.strictObject({
    type: z.literal('extension_ui_request'),
    id,
    method: z.literal('set_editor_text'),
    text: text(),
  }),
])
const entryMetadata = {
  timestamp: z.string().datetime({ offset: true }).optional(),
}
export const bodySchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...entryMetadata,
    type: z.literal('message'),
    message: messageSchema,
    attachmentIds: z.array(id).max(4).optional(),
  }),
  z.strictObject({
    ...entryMetadata,
    type: z.literal('model_change'),
    provider: text(),
    modelId: text(),
  }),
  z.strictObject({
    ...entryMetadata,
    type: z.literal('thinking_level_change'),
    thinkingLevel: text(128),
  }),
  z.strictObject({
    ...entryMetadata,
    type: z.literal('compaction'),
    summary: text(4 * MiB),
    firstKeptEntryId: id,
    tokensBefore: count,
    details: inert.optional(),
    usage: usageSchema.optional(),
    fromHook: z.boolean().optional(),
  }),
  z.strictObject({
    ...entryMetadata,
    type: z.literal('branch_summary'),
    fromId: id,
    summary: text(4 * MiB),
    details: inert.optional(),
    usage: usageSchema.optional(),
    fromHook: z.boolean().optional(),
  }),
  z.strictObject({
    ...entryMetadata,
    type: z.literal('custom'),
    customType: text(),
    data: inert.optional(),
  }),
  z.strictObject({
    ...entryMetadata,
    type: z.literal('custom_message'),
    customType: text(),
    content,
    details: inert.optional(),
    display: z.boolean(),
  }),
  z.strictObject({
    ...entryMetadata,
    type: z.literal('label'),
    targetId: id,
    label: text().optional(),
  }),
  z.strictObject({
    ...entryMetadata,
    type: z.literal('session_info'),
    name: text().optional(),
  }),
  z.strictObject({
    ...entryMetadata,
    type: z.literal('ui_request'),
    requestId: id,
    native: uiRequestSchema,
    status: z.enum(['pending', 'expired']),
    reason: text().optional(),
  }),
  z.strictObject({
    ...entryMetadata,
    type: z.literal('ui_reply'),
    requestId: id,
    native: uiResponseSchema,
    status: z.literal('submitted'),
  }),
  z.strictObject({
    ...entryMetadata,
    type: z.literal('ui_metadata'),
    native: uiMetadataSchema,
  }),
])
export type PiRecordBody = z.infer<typeof bodySchema>
export type PiRecordSource =
  | {
      kind: 'live'
      runtimeGeneration: string
      ordinal: number
      runId?: string
      turnId?: string
      forgeItemIds: string[]
    }
  | {
      kind: 'history'
      sessionId: string
      sessionFile: string
      importOperationId: string
      ordinal: number
      entryId: string
      parentId: string | null
    }
export type PiNativeRecord = Readonly<{
  source: PiRecordSource
  body: PiRecordBody
}>
function redactDetails(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redact(value, secrets)
  if (Array.isArray(value))
    return value.map((item) => redactDetails(item, secrets))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redact(key, secrets),
        redactDetails(item, secrets),
      ]),
    )
  return value
}
export function decodeMessage(
  value: unknown,
  secrets: readonly string[] = [],
): PiMessage {
  const message = messageSchema.parse(value)
  if (message.role === 'assistant') {
    if (message.errorMessage)
      message.errorMessage = redact(message.errorMessage, secrets)
    if (message.rawStopReason)
      message.rawStopReason = redact(message.rawStopReason, secrets)
    for (const diagnostic of message.diagnostics ?? []) {
      if (diagnostic.error) {
        diagnostic.error.message = redact(diagnostic.error.message, secrets)
        if (diagnostic.error.stack)
          diagnostic.error.stack = redact(diagnostic.error.stack, secrets)
      }
      if (diagnostic.details)
        diagnostic.details = redactDetails(diagnostic.details, secrets)
    }
  }
  return freeze(message)
}
export function decodeEntry(
  value: unknown,
  secrets: readonly string[] = [],
): { id: string; parentId: string | null; body: PiRecordBody } {
  const entry = z
    .object({
      id,
      parentId: id.nullable(),
      timestamp: z.string().datetime({ offset: true }),
    })
    .passthrough()
    .parse(value)
  const { id: entryId, parentId, ...body } = entry
  if (
    ![
      'message',
      'model_change',
      'thinking_level_change',
      'compaction',
      'branch_summary',
      'custom',
      'custom_message',
      'label',
      'session_info',
    ].includes(String(body.type))
  )
    fail('PI_HISTORY_ENTRY_UNSUPPORTED')
  if (body.type === 'message')
    body.message = decodeMessage(body.message, secrets)
  return freeze({ id: entryId, parentId, body: bodySchema.parse(body) })
}
type Envelope = { runId: string; turnId: string; runtimeGeneration: string }
type Block = {
  type: 'text' | 'thinking' | 'toolCall'
  text: string
  itemId: string
  published: boolean
}
type Current = {
  ordinal: number
  role: PiMessage['role']
  blocks: Map<number, Block>
}
export class PiNormalizer {
  private ordinal = 0
  private itemCount = 0
  private retained = 0
  private assistant?: Current
  private transient?: Current
  private tools = new Map<string, { itemId: string; terminal: boolean }>()
  finalAssistant?: Pick<Extract<PiMessage, { role: 'assistant' }>, 'stopReason'>
  constructor(
    private readonly owner: Envelope,
    private readonly config: Readonly<PiLimits>,
    private readonly emit: (event: HarnessEvent) => void,
    private readonly nextId: () => string,
    private readonly secrets: readonly string[] = [],
  ) {}
  get hasOpenMessage() {
    return !!(this.assistant || this.transient)
  }
  private item() {
    if (++this.itemCount > this.config.maxItems) fail('PI_ITEM_LIMIT')
    return `${this.owner.runtimeGeneration}:${this.owner.runId}:item:${this.itemCount}`
  }
  private block(current: Current, index: number, type: Block['type']) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= 256)
      fail('PI_CONTENT_INDEX')
    let block = current.blocks.get(index)
    if (block && block.type !== type) fail('PI_CONTENT_TYPE_CHANGED')
    if (!block) {
      block = { type, text: '', itemId: this.item(), published: false }
      current.blocks.set(index, block)
    }
    return block
  }
  private set(block: Block, value: string) {
    const size = Buffer.byteLength(value)
    this.retained += size - Buffer.byteLength(block.text)
    if (
      size > this.config.maxBlockBytes ||
      this.retained > this.config.maxContentBytes
    )
      fail('PI_CONTENT_LIMIT')
    block.text = value
  }
  start(value: unknown) {
    const message = decodeMessage(value, this.secrets)
    const current = {
      ordinal: ++this.ordinal,
      role: message.role,
      blocks: new Map<number, Block>(),
    }
    if (message.role === 'assistant') {
      if (this.assistant) fail('PI_OVERLAPPING_MESSAGE')
      this.assistant = current
    } else {
      if (this.transient) fail('PI_OVERLAPPING_MESSAGE')
      this.transient = current
    }
    return message
  }
  update(value: unknown) {
    const event = z
      .object({
        type: text(64),
        contentIndex: count.max(255),
        delta: text(4 * MiB).optional(),
        content: text(4 * MiB).optional(),
        toolCall: toolCall.optional(),
      })
      .strict()
      .parse(value)
    const current = this.assistant
    if (!current) fail('PI_MESSAGE_OWNER_MISSING')
    const type = event.type.startsWith('text_')
      ? 'text'
      : event.type.startsWith('thinking_')
        ? 'thinking'
        : event.type.startsWith('toolcall_')
          ? 'toolCall'
          : fail('PI_STREAM_EVENT_UNSUPPORTED')
    const block = this.block(current, event.contentIndex, type)
    if (event.type.endsWith('_start')) return
    if (event.type.endsWith('_delta')) {
      if (event.delta === undefined) fail('PI_MALFORMED_DELTA')
      this.set(block, block.text + event.delta)
      if (type !== 'toolCall') {
        this.emit({
          ...this.owner,
          deliveryId: this.nextId(),
          itemId: block.itemId,
          type: type === 'text' ? 'text_delta' : 'thought_delta',
          text: event.delta,
        })
        block.published = true
      }
    } else if (event.type.endsWith('_end')) {
      if (type === 'toolCall') {
        if (!event.toolCall) fail('PI_MALFORMED_TOOLCALL')
        this.set(block, JSON.stringify(event.toolCall.arguments))
      } else {
        if (event.content === undefined) fail('PI_MALFORMED_CONTENT')
        this.replace(block, event.content)
      }
    } else fail('PI_STREAM_EVENT_UNSUPPORTED')
  }
  private replace(block: Block, value: string, role?: 'user' | 'assistant') {
    if (block.published && block.text === value) return
    this.set(block, value)
    if (block.type === 'toolCall') return
    if (block.type === 'thinking')
      this.emit({
        ...this.owner,
        deliveryId: this.nextId(),
        type: 'content_snapshot',
        itemId: block.itemId,
        contentType: 'thought',
        text: value,
      })
    else
      this.emit({
        ...this.owner,
        deliveryId: this.nextId(),
        type: 'content_snapshot',
        itemId: block.itemId,
        contentType: 'text',
        text: value,
        ...(role ? { role } : {}),
      })
    block.published = true
  }
  end(value: unknown): { message: PiMessage; itemIds: string[] } {
    const message = decodeMessage(value, this.secrets)
    let current = message.role === 'assistant' ? this.assistant : this.transient
    if (!current)
      current = {
        ordinal: ++this.ordinal,
        role: message.role,
        blocks: new Map(),
      }
    if (current.role !== message.role) fail('PI_MESSAGE_ROLE_CHANGED')
    if (message.role === 'assistant') {
      this.finalAssistant = { stopReason: message.stopReason }
      const present = new Set<number>()
      message.content.forEach((part, index) => {
        present.add(index)
        const block = this.block(current!, index, part.type)
        if (part.type === 'text') this.replace(block, part.text)
        else if (part.type === 'thinking') this.replace(block, part.thinking)
        else this.set(block, JSON.stringify(part.arguments))
      })
      for (const [index, block] of current.blocks)
        if (!present.has(index)) this.replace(block, '')
      const u = message.usage
      this.emit({
        ...this.owner,
        deliveryId: this.nextId(),
        type: 'usage',
        itemId: this.item(),
        inputTokens: u.input,
        outputTokens: u.output,
        totalTokens: u.totalTokens,
        ...(u.cacheRead === undefined
          ? {}
          : { cachedInputTokens: u.cacheRead }),
        ...(u.cacheWrite === undefined
          ? {}
          : { cacheWriteInputTokens: u.cacheWrite }),
        ...(u.reasoning === undefined
          ? {}
          : { reasoningOutputTokens: u.reasoning }),
      })
      this.assistant = undefined
    } else {
      if (message.role === 'user') {
        const parts =
          typeof message.content === 'string'
            ? [{ type: 'text', text: message.content }]
            : message.content
        parts.forEach((part, index) => {
          if (part.type === 'text')
            this.replace(this.block(current!, index, 'text'), part.text, 'user')
        })
      } else if (message.role === 'toolResult')
        this.toolEnd(message.toolCallId, message.content, message.isError)
      this.transient = undefined
    }
    const itemIds = [...current.blocks.values()].map((b) => b.itemId)
    for (const block of current.blocks.values())
      this.retained -= Buffer.byteLength(block.text)
    return { message, itemIds }
  }
  private tool(nativeId: string) {
    id.parse(nativeId)
    let tool = this.tools.get(nativeId)
    if (!tool) {
      if (this.tools.size >= this.config.maxTools) fail('PI_TOOL_LIMIT')
      tool = { itemId: this.item(), terminal: false }
      this.tools.set(nativeId, tool)
    }
    return tool
  }
  toolStart(value: unknown) {
    const e = z
      .strictObject({
        type: z.literal('tool_execution_start'),
        toolCallId: id,
        toolName: text(),
        args: inert,
      })
      .parse(value)
    const tool = this.tool(e.toolCallId)
    this.emit({
      ...this.owner,
      deliveryId: this.nextId(),
      type: 'tool_started',
      itemId: tool.itemId,
      toolCallId: e.toolCallId,
      name: e.toolName,
      input: e.args,
    })
  }
  toolUpdate(value: unknown) {
    const e = z
      .strictObject({
        type: z.literal('tool_execution_update'),
        toolCallId: id,
        toolName: text(),
        args: inert,
        partialResult: toolResultSchema,
      })
      .parse(value)
    const tool = this.tool(e.toolCallId)
    if (tool.terminal) fail('PI_TOOL_UPDATE_AFTER_END')
    const output = this.toolText(e.partialResult)
    this.emit({
      ...this.owner,
      deliveryId: this.nextId(),
      type: 'tool_update',
      itemId: tool.itemId,
      toolCallId: e.toolCallId,
      status: 'running',
      output,
    })
  }
  toolEventEnd(value: unknown) {
    const e = z
      .strictObject({
        type: z.literal('tool_execution_end'),
        toolCallId: id,
        toolName: text(),
        result: toolResultSchema,
        isError: z.boolean(),
      })
      .parse(value)
    this.toolEnd(e.toolCallId, e.result, e.isError)
  }
  private toolText(result: unknown): string {
    const content = Array.isArray(result)
      ? result
      : (result as { content?: unknown })?.content
    if (!Array.isArray(content)) return ''
    const output = content
      .flatMap((part) =>
        part?.type === 'text' && typeof part.text === 'string'
          ? [part.text]
          : [],
      )
      .join('\n')
    if (Buffer.byteLength(output) > this.config.maxBlockBytes)
      fail('PI_TOOL_OUTPUT_LIMIT')
    return output
  }
  private toolEnd(nativeId: string, result: unknown, isError: boolean) {
    const tool = this.tool(nativeId)
    if (tool.terminal) return
    tool.terminal = true
    this.emit({
      ...this.owner,
      deliveryId: this.nextId(),
      type: 'tool_update',
      itemId: tool.itemId,
      toolCallId: nativeId,
      status: isError ? 'failed' : 'completed',
      output: this.toolText(result),
    })
  }
  retainedBytes() {
    return this.retained + bytes([...this.tools])
  }
}
