import { createHash, randomBytes } from 'node:crypto'
import type { TerminalOutcome } from '@forge/protocol/harness'
import {
  array,
  bound,
  bytes,
  fault,
  nativeId,
  object,
  string,
  RetainedBudget,
  type OpenCodeLimits,
} from './opencode-http.js'

export const tuple = (...values: string[]) => JSON.stringify(values)
export const stableId = (...values: string[]) =>
  createHash('sha256')
    .update(tuple(...values))
    .digest('hex')
let lastTimestamp = 0
let counter = 0
/** Native ascending IDs: low six timestamp/counter bytes and a random base62 suffix.
 * Layout: opencode v1.18.26, packages/schema/src/identifier.ts.
 * Copyright (c) 2025 opencode. MIT permission notice below.
 */
export function newNativeId(prefix: 'msg' | 'prt') {
  const now = Math.max(Date.now(), lastTimestamp)
  counter = now === lastTimestamp ? counter + 1 : 1
  lastTimestamp = now
  if (counter >= 4096) {
    lastTimestamp++
    counter = 1
  }
  const time = BigInt.asUintN(
    48,
    BigInt(lastTimestamp) * 4096n + BigInt(counter),
  )
    .toString(16)
    .padStart(12, '0')
  const alphabet =
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  const suffix = Array.from(
    randomBytes(14),
    (byte) => alphabet[byte % 62],
  ).join('')
  return `${prefix}_${time}${suffix}`
}

export class BoundedStore<T> extends Map<string, T> {
  private readonly sizes = new Map<string, number>()
  private sizeBytes = 0
  constructor(
    private readonly label: string,
    private readonly maximum: number,
    private readonly byteMaximum: number,
    private readonly budget: RetainedBudget,
  ) {
    super()
  }
  put(key: string, value: T, retained: unknown = value) {
    this.putSized(key, value, bytes([key, retained]))
  }
  retainedSize(key: string) {
    return this.sizes.get(key) ?? 0
  }
  putSized(key: string, value: T, size: number) {
    if (
      (!this.has(key) && this.size >= this.maximum) ||
      this.sizeBytes - (this.sizes.get(key) ?? 0) + size > this.byteMaximum
    )
      throw fault('CAPACITY', `${this.label} exceeds its retained limit`)
    this.budget.putBytes(tuple(this.label, key), size, this.byteMaximum)
    this.sizeBytes += size - (this.sizes.get(key) ?? 0)
    this.sizes.set(key, size)
    super.set(key, value)
  }
  override delete(key: string) {
    this.sizeBytes -= this.sizes.get(key) ?? 0
    this.sizes.delete(key)
    this.budget.delete(tuple(this.label, key))
    return super.delete(key)
  }
  override clear() {
    for (const key of this.keys()) this.delete(key)
  }
}

export type NativeEnvelope = {
  directory: string
  payload: { id: string; type: string; properties: Record<string, unknown> }
}
export function envelope(
  value: unknown,
  limits: OpenCodeLimits,
): NativeEnvelope {
  const outer = object(value)
  const payload = object(outer.payload)
  const directory = string(outer.directory, 4096)
  const id = nativeId(payload.id, 'evt_', limits.idBytes)
  const type = string(payload.type, limits.idBytes)
  const properties = object(payload.properties)
  return { directory, payload: { id, type, properties } }
}
export type NativeMessage = {
  id: string
  sessionID: string
  role: 'user' | 'assistant'
  created: number
  parentID?: string
  completed?: number
  finish?: string
  error?: unknown
  model?: string
  tokens?: {
    input: number
    output: number
    total: number
    reasoning: number
    read: number
    write: number
  }
}
export function compareMessages(a: NativeMessage, b: NativeMessage) {
  return a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}
export function messageInfo(
  value: unknown,
  limits: OpenCodeLimits,
): NativeMessage {
  const info = object(value)
  const result: NativeMessage = {
    id: nativeId(info.id, 'msg', limits.idBytes),
    sessionID: nativeId(info.sessionID, 'ses', limits.idBytes),
    role: info.role as NativeMessage['role'],
    created: 0,
  }
  if (result.role !== 'user' && result.role !== 'assistant')
    throw fault('PROTOCOL', 'Invalid native message role')
  const time = object(info.time)
  if (
    typeof time.created !== 'number' ||
    !Number.isFinite(time.created) ||
    time.created < 0
  )
    throw fault('PROTOCOL', 'Invalid native message time')
  result.created = time.created as number
  if (time.completed !== undefined) result.completed = count(time.completed)
  if (result.role === 'assistant') {
    result.parentID = nativeId(info.parentID, 'msg', limits.idBytes)
    if (info.finish !== undefined) result.finish = string(info.finish)
    if (info.error !== undefined) {
      bound(info.error, limits.errorBytes, 'Native message error')
      result.error = info.error
    }
    if (info.providerID !== undefined && info.modelID !== undefined)
      result.model = `${string(info.providerID)}/${string(info.modelID)}`
    if (info.tokens !== undefined) {
      const tokens = object(info.tokens)
      const cache = object(tokens.cache)
      const input = count(tokens.input)
      const output = count(tokens.output)
      const read = count(cache.read)
      const write = count(cache.write)
      result.tokens = {
        input,
        output,
        read,
        write,
        reasoning: count(tokens.reasoning),
        total: count(tokens.total ?? input + output + read + write),
      }
    }
  } else if (info.model !== undefined) {
    const model = object(info.model)
    result.model = `${string(model.providerID)}/${string(model.modelID)}`
  }
  return result
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw fault('PROTOCOL', 'Invalid native token count or time')
  return value
}
export type NativePart = Record<string, unknown> & {
  id: string
  sessionID: string
  messageID: string
  type: string
}
export function partInfo(value: unknown, limits: OpenCodeLimits): NativePart {
  const part = object(value)
  const id = nativeId(part.id, 'prt', limits.idBytes)
  const messageID = nativeId(part.messageID, 'msg', limits.idBytes)
  const sessionID = nativeId(part.sessionID, 'ses', limits.idBytes)
  const type = string(part.type)
  if (type === 'text' || type === 'reasoning') {
    if (typeof part.text !== 'string')
      throw fault('PROTOCOL', 'Native content is missing text')
    bound(part.text, limits.textBytes, 'Native text')
  } else if (type === 'tool') {
    string(part.callID)
    string(part.tool)
    const state = object(part.state)
    object(state.input)
    if (
      !['pending', 'running', 'completed', 'error'].includes(
        String(state.status),
      )
    )
      throw fault('PROTOCOL', 'Invalid native tool status')
    if (
      (state.status === 'completed' && typeof state.output !== 'string') ||
      (state.status === 'error' && typeof state.error !== 'string')
    )
      throw fault('PROTOCOL', 'Native terminal tool state is incomplete')
    bound(state.input, limits.toolInputBytes, 'Native tool input')
    bound(state.output, limits.toolOutputBytes, 'Native tool output')
    bound(state.error, limits.toolOutputBytes, 'Native tool error')
    bound(state.metadata, limits.toolMetadataBytes, 'Native tool metadata')
  }
  bound(part, limits.partBytes, 'Native part')
  return { ...part, id, messageID, sessionID, type }
}
export type Snapshot = { info: NativeMessage; parts: NativePart[] }
export function snapshot(value: unknown, limits: OpenCodeLimits): Snapshot {
  const row = object(value)
  const info = messageInfo(row.info, limits)
  const parts = array(row.parts, limits.partCount).map((part) =>
    partInfo(part, limits),
  )
  const ids = new Set<string>()
  for (const part of parts) {
    if (
      part.sessionID !== info.sessionID ||
      part.messageID !== info.id ||
      ids.has(part.id)
    )
      throw fault('PROTOCOL', 'Native message and part identities disagree')
    ids.add(part.id)
  }
  return { info, parts }
}
export type EventOwner = {
  runId: string
  turnId: string
  userId: string
  sessionId: string
  childId?: string
  parentChildId?: string
}
type PartState = {
  part: NativePart
  owner: EventOwner
  text?: string[]
  textBytes?: number
  digest?: string
  toolId?: string
}
type Emit = (
  owner: EventOwner,
  event: Record<string, unknown>,
  source?: string,
) => void

/** One projection for native history and live facts. Lifecycle remains in the adapter. */
export class OpenCodeEvents {
  readonly messages: BoundedStore<NativeMessage>
  readonly parts: BoundedStore<PartState>
  private readonly usage: BoundedStore<string>
  constructor(
    private readonly limits: OpenCodeLimits,
    budget: RetainedBudget,
    private readonly emit: Emit,
    private readonly modelContext: (model?: string) => number | undefined,
  ) {
    this.messages = new BoundedStore(
      'messages',
      limits.ownerCount,
      limits.ownerBytes,
      budget,
    )
    this.parts = new BoundedStore(
      'parts',
      limits.partCount,
      limits.partBytes,
      budget,
    )
    this.usage = new BoundedStore(
      'usage',
      limits.ownerCount,
      limits.ownerBytes,
      budget,
    )
  }
  message(info: NativeMessage, owner: EventOwner, source?: string) {
    const key = tuple(info.sessionID, info.id)
    const old = this.messages.get(key)
    if (old && (old.role !== info.role || old.parentID !== info.parentID))
      throw fault('PROTOCOL', 'Native message ownership changed')
    this.messages.put(key, info)
    if (info.tokens) {
      const digest = stableId(JSON.stringify(info.tokens))
      if (this.usage.get(key) !== digest) {
        this.usage.put(key, digest)
        this.emit(
          owner,
          {
            type: 'usage',
            itemId: stableId(key, 'usage'),
            providerItemId: info.id,
            inputTokens: info.tokens.input,
            outputTokens: info.tokens.output,
            totalTokens: info.tokens.total,
            cachedInputTokens: info.tokens.read,
            cacheWriteInputTokens: info.tokens.write,
            reasoningOutputTokens: info.tokens.reasoning,
            modelContextWindow: this.modelContext(info.model),
          },
          source,
        )
      }
    }
  }
  part(
    part: NativePart,
    owner: EventOwner,
    role: 'user' | 'assistant',
    source?: string,
  ) {
    if (role === 'user' && !owner.childId) return
    const key = tuple(part.sessionID, part.messageID, part.id)
    const old = this.parts.get(key)
    if (
      old &&
      (old.part.type !== part.type || old.owner.userId !== owner.userId)
    )
      throw fault('PROTOCOL', 'Native part ownership or kind changed')
    const digest = stableId(JSON.stringify(part))
    if (old?.digest === digest) return
    const itemId = stableId(key, part.type)
    const common = { itemId, providerItemId: part.id }
    const state: PartState = { part, owner, digest }
    const events: Record<string, unknown>[] = []
    if (part.type === 'text' || part.type === 'reasoning') {
      const text = part.text as string
      state.text = [text]
      state.textBytes = bytes(text)
      const previousText = old?.text?.join('')
      const metadata = part.type === 'text' ? pickTextMetadata(part) : {}
      const metadataChanged =
        JSON.stringify(pickTextMetadata(old?.part ?? {})) !==
        JSON.stringify(metadata)
      if (
        (!old ||
          (previousText !== undefined && text.startsWith(previousText))) &&
        !metadataChanged &&
        Object.keys(metadata).length === 0
      ) {
        const suffix = text.slice(previousText?.length ?? 0)
        if (suffix)
          events.push({
            ...common,
            type: part.type === 'text' ? 'text_delta' : 'thought_delta',
            text: suffix,
            ...(part.type === 'text' && role === 'user' ? { role } : {}),
          })
      } else {
        events.push({
          ...common,
          type: 'content_snapshot',
          contentType: part.type === 'text' ? 'text' : 'thought',
          text,
          ...(part.type === 'text' ? { role, ...metadata } : {}),
        })
      }
    } else if (part.type === 'tool') {
      const tool = object(part.state)
      const toolId = stableId(
        part.sessionID,
        part.messageID,
        string(part.callID),
      )
      state.toolId = toolId
      if (!old)
        events.push({
          ...common,
          type: 'tool_started',
          toolCallId: toolId,
          name: part.tool,
          input: tool.input ?? {},
        })
      events.push({
        ...common,
        type: 'tool_update',
        toolCallId: toolId,
        status: tool.status,
        output: {
          ...(tool.output !== undefined ? { output: tool.output } : {}),
          ...(tool.error !== undefined ? { error: tool.error } : {}),
          ...(tool.metadata !== undefined ? { metadata: tool.metadata } : {}),
          input: tool.input ?? {},
        },
      })
    } else if (
      ![
        'step-start',
        'step-finish',
        'snapshot',
        'patch',
        'compaction',
        'subtask',
        'retry',
        'agent',
      ].includes(part.type)
    ) {
      events.push({
        ...common,
        type: 'diagnostic',
        code: 'OPENCODE_PART_UNSUPPORTED',
        message: 'A native part has no approved display mapping',
        severity: 'warning',
      })
    }
    this.parts.put(key, state)
    for (const event of events) this.emit(owner, event, source)
  }
  delta(
    sessionId: string,
    messageId: string,
    partId: string,
    delta: string,
    source: string,
  ) {
    const key = tuple(sessionId, messageId, partId)
    const old = this.parts.get(key)
    if (
      !old ||
      old.text === undefined ||
      !['text', 'reasoning'].includes(old.part.type)
    )
      return false
    const textBytes = (old.textBytes ?? 0) + bytes(delta)
    if (textBytes > this.limits.textBytes)
      throw fault('CAPACITY', 'Native text exceeds its byte limit')
    // Charge the new segment before retention. Materialize only for a full snapshot.
    this.parts.putSized(
      key,
      old,
      this.parts.retainedSize(key) + bytes(delta) + 16,
    )
    old.text.push(delta)
    old.textBytes = textBytes
    old.digest = undefined
    if (delta)
      this.emit(
        old.owner,
        {
          type: old.part.type === 'text' ? 'text_delta' : 'thought_delta',
          itemId: stableId(key, old.part.type),
          providerItemId: partId,
          text: delta,
          ...(old.part.type === 'text' &&
          this.messages.get(tuple(sessionId, messageId))?.role === 'user'
            ? { role: 'user' }
            : {}),
        },
        source,
      )
    return true
  }
  verifyNoDeletion(rows: Snapshot[], sessionId: string) {
    const byMessage = new Map(
      rows.map((row) => [
        row.info.id,
        new Set(row.parts.map((part) => part.id)),
      ]),
    )
    for (const state of this.parts.values()) {
      if (
        state.part.sessionID === sessionId &&
        byMessage.has(state.part.messageID) &&
        !byMessage.get(state.part.messageID)!.has(state.part.id)
      )
        throw fault('HISTORY_GAP', 'Native history removed an emitted part')
    }
  }
  terminal(rows: Snapshot[], userId: string): TerminalOutcome | undefined {
    if (!rows.some((row) => row.info.id === userId && row.info.role === 'user'))
      return
    const assistants = rows.filter((row) => row.info.parentID === userId)
    if (
      assistants.some((row) =>
        row.parts.some(
          (part) =>
            part.type === 'tool' &&
            ['pending', 'running'].includes(String(object(part.state).status)),
        ),
      )
    )
      return
    const last = assistants.at(-1)?.info
    if (!last) return
    if (last.error !== undefined)
      return {
        status: 'failed',
        code: 'OPENCODE_NATIVE_ERROR',
        message: 'Native assistant reported an error',
      }
    if (
      last.completed !== undefined &&
      last.finish &&
      !['tool-calls', 'unknown'].includes(last.finish)
    )
      return { status: 'completed' }
  }
  release(owner: EventOwner) {
    for (const [key, state] of this.parts) {
      if (
        state.owner.sessionId !== owner.sessionId ||
        state.owner.userId !== owner.userId
      )
        continue
      const part = { ...state.part }
      delete part.text
      if (part.type === 'tool') {
        const tool = object(part.state)
        part.state = { status: tool.status }
      }
      this.parts.put(key, {
        ...state,
        part,
        text: undefined,
        textBytes: undefined,
      })
    }
  }
  clear() {
    this.messages.clear()
    this.parts.clear()
    this.usage.clear()
  }
}
function pickTextMetadata(part: Record<string, unknown>) {
  return Object.fromEntries(
    ['phase', 'delivery', 'questions']
      .filter((key) => Object.hasOwn(part, key))
      .map((key) => [key, part[key]]),
  )
}

/* Identifier layout license:
Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
