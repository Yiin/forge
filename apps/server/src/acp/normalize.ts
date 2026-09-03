import type * as acp from '@agentclientprotocol/sdk'
import type {
  PromptResponse,
  AgentProcessDiedError,
  AcpClient,
} from './client.js'
import { PromptBusyError } from './client.js'
import { appendMessage, type AppendMessage } from '../db/queries.js'
import type { EventBus } from '../events/bus.js'
import {
  createSubagentTurn,
  detectToolCall,
  finalizeSubagents,
  updateToolCall,
  type SubagentTurn,
} from './subagents.js'

type Db = { exec(sql: string): unknown; prepare(sql: string): any }
export type Logger = Pick<Console, 'warn'>
type BufferKey = `${string}:${string}`
type BufferState = {
  text: string
  itemId: string
  type: 'text_delta' | 'thought_delta'
  timer?: ReturnType<typeof setTimeout>
}

export type NormalizerOptions = {
  db: Db
  bus?: EventBus
  logger?: Logger
  now?: () => number
  sink?: (input: AppendMessage) => void
}

const textOf = (content: acp.ContentBlock | undefined) =>
  content?.type === 'text' ? content.text : ''

const ulid = () =>
  `${Date.now().toString(36)}${crypto.randomUUID().replaceAll('-', '')}`
const newItem = () => ulid()

export class AcpNormalizer {
  private readonly buffers = new Map<BufferKey, BufferState>()
  private readonly continuations = new Map<
    BufferKey,
    Pick<BufferState, 'itemId' | 'type'>
  >()
  private readonly turns = new Map<
    string,
    {
      turnId: string
      closed: boolean
      subagents: SubagentTurn
      openTools: Map<string, string>
    }
  >()
  private readonly commands = new Map<string, readonly unknown[]>()
  private readonly logger: Logger
  private readonly now: () => number

  constructor(private readonly options: NormalizerOptions) {
    this.logger = options.logger ?? console
    this.now = options.now ?? Date.now
  }

  get availableCommands() {
    return this.commands
  }

  beginTurn(sessionId: string, turnId = ulid()) {
    this.turns.set(sessionId, {
      turnId,
      closed: false,
      subagents: createSubagentTurn(),
      openTools: new Map(),
    })
    this.append(sessionId, turnId, newItem(), 'turn_start', {
      type: 'turn_start',
    })
    return turnId
  }

  private turnFor(sessionId: string) {
    const current = this.turns.get(sessionId)
    if (current && !current.closed) return current.turnId
    const turnId = `autonomous-${ulid()}`
    this.turns.set(sessionId, {
      turnId,
      closed: false,
      subagents: createSubagentTurn(),
      openTools: new Map(),
    })
    this.append(sessionId, turnId, newItem(), 'turn_start', {
      type: 'turn_start',
    })
    return turnId
  }

  private append(
    sessionId: string,
    turnId: string,
    itemId: string,
    type: string,
    content: unknown,
  ) {
    const input: AppendMessage = {
      sessionId,
      turnId,
      itemId,
      role: 'agent',
      type,
      content,
      createdAt: this.now(),
      eventBus: this.options.bus,
    }
    if (this.options.sink) this.options.sink(input)
    else appendMessage(this.options.db, input)
  }

  private flushKey(key: BufferKey, continueItem = false) {
    const state = this.buffers.get(key)
    if (!state) {
      if (!continueItem) this.continuations.delete(key)
      return
    }
    if (state.timer) clearTimeout(state.timer)
    this.buffers.delete(key)
    if (continueItem) this.continuations.set(key, state)
    else this.continuations.delete(key)
    const [sessionId, turnId] = key.split(':')
    this.append(sessionId, turnId, state.itemId, state.type, {
      type: state.type,
      text: state.text,
    })
  }

  flush(sessionId?: string, turnId?: string) {
    const keys = new Set([...this.buffers.keys(), ...this.continuations.keys()])
    for (const key of keys) {
      const [keySession, keyTurn] = key.split(':')
      if (
        (!sessionId || keySession === sessionId) &&
        (!turnId || keyTurn === turnId)
      )
        this.flushKey(key)
    }
  }

  private delta(
    sessionId: string,
    turnId: string,
    type: BufferState['type'],
    text: string,
  ) {
    const key: BufferKey = `${sessionId}:${turnId}`
    let state = this.buffers.get(key)
    if (!state || state.type !== type) {
      if (state) this.flushKey(key)
      const continuation = this.continuations.get(key)
      state = {
        text: '',
        itemId: continuation?.type === type ? continuation.itemId : newItem(),
        type,
      }
      if (continuation?.type !== type) this.continuations.delete(key)
      this.buffers.set(key, state)
    }
    while (text.length) {
      const room = 2048 - state.text.length
      state.text += text.slice(0, room)
      text = text.slice(room)
      if (state.text.length === 2048) {
        this.flushKey(key, true)
        if (text.length) {
          state = { text: '', itemId: state.itemId, type }
          this.buffers.set(key, state)
        }
      }
    }
    if (this.buffers.has(key) && !state.timer)
      state.timer = setTimeout(() => this.flushKey(key, true), 500)
  }

  async handle(notification: acp.SessionNotification) {
    const { sessionId, update } = notification
    const state = this.turns.get(sessionId)
    const value = update as any
    if (
      state?.closed &&
      (value.sessionUpdate !== 'tool_call_update' ||
        (value.status !== 'completed' && value.status !== 'failed'))
    )
      return
    const turnId = state?.closed ? state.turnId : this.turnFor(sessionId)
    switch ((value as { sessionUpdate?: string }).sessionUpdate) {
      case 'agent_message_chunk':
        this.delta(sessionId, turnId, 'text_delta', textOf(value.content))
        return
      case 'agent_thought_chunk':
        this.delta(sessionId, turnId, 'thought_delta', textOf(value.content))
        return
      case 'tool_call':
        this.flush(sessionId, turnId)
        {
          const subagent = detectToolCall(
            stateFor(this.turns, sessionId),
            value,
          )
          const itemId = value.toolCallId
          this.turns.get(sessionId)!.openTools.set(itemId, itemId)
          this.append(sessionId, turnId, value.toolCallId, 'tool_call', {
            type: 'tool_call',
            toolCallId: value.toolCallId,
            name: value.title,
            input: value.rawInput,
            ...(subagent ? { subagent } : {}),
          })
        }
        return
      case 'tool_call_update':
        this.flush(sessionId, turnId)
        {
          const subagent = updateToolCall(
            stateFor(this.turns, sessionId),
            value,
            this.logger,
          )
          this.append(sessionId, turnId, value.toolCallId, 'tool_update', {
            type: 'tool_update',
            toolCallId: value.toolCallId,
            status: value.status ?? 'unknown',
            output: value.rawOutput ?? value.content,
            ...(subagent ? { subagent } : {}),
          })
          if (
            (value.status === 'completed' || value.status === 'failed') &&
            (!subagent ||
              subagent.status === 'completed' ||
              subagent.status === 'failed')
          ) {
            this.append(sessionId, turnId, value.toolCallId, 'tool_result', {
              type: 'tool_result',
              toolCallId: value.toolCallId,
              output: value.rawOutput ?? value.content ?? null,
              isError: value.status === 'failed',
              ...(subagent ? { subagent } : {}),
            })
            this.turns.get(sessionId)!.openTools.delete(value.toolCallId)
          }
        }
        return
      case 'plan':
        this.flush(sessionId, turnId)
        {
          const itemId = newItem()
          this.append(sessionId, turnId, itemId, 'tool_call', {
            type: 'tool_call',
            toolCallId: itemId,
            name: 'plan',
            input: value.entries,
          })
          this.append(sessionId, turnId, itemId, 'tool_result', {
            type: 'tool_result',
            toolCallId: itemId,
            output: null,
            isError: false,
          })
        }
        return
      case 'available_commands_update':
        this.commands.set(sessionId, value.availableCommands)
        this.options.bus?.publish({
          seq: null,
          type: 'availableCommands',
          sessionId,
          commands: value.availableCommands,
        })
        return
      case 'current_mode_update':
        return
      default:
        this.logger.warn(
          `Unknown ACP session update: ${(update as { sessionUpdate?: unknown }).sessionUpdate ?? '<missing>'}`,
        )
    }
  }

  endTurn(sessionId: string, response: PromptResponse) {
    const current = this.turns.get(sessionId)
    if (!current || current.closed) return
    this.flush(sessionId, current.turnId)
    const isError = response.stopReason !== 'end_turn'
    for (const [toolCallId, itemId] of current.openTools) {
      const subagent = current.subagents.records.find(
        (record) => record.toolCallId === toolCallId,
      )
      if (subagent) continue
      this.append(sessionId, current.turnId, itemId, 'tool_result', {
        type: 'tool_result',
        toolCallId,
        output: null,
        isError,
      })
    }
    for (const subagent of finalizeSubagents(current.subagents))
      this.append(
        sessionId,
        current.turnId,
        subagent.toolCallId,
        'tool_result',
        {
          type: 'tool_result',
          toolCallId: subagent.toolCallId,
          output: null,
          isError: false,
          subagent,
        },
      )
    this.append(sessionId, current.turnId, newItem(), 'turn_end', {
      type: 'turn_end',
      stopReason: response.stopReason,
    })
    current.closed = true
  }

  interrupt(sessionId: string, reason = 'cancelled') {
    const current = this.turns.get(sessionId)
    if (!current || current.closed) return
    this.flush(sessionId, current.turnId)
    this.append(sessionId, current.turnId, newItem(), 'turn_interrupted', {
      type: 'turn_interrupted',
      reason,
    })
    current.closed = true
  }

  processDied(sessionId: string, error: AgentProcessDiedError) {
    const current = this.turns.get(sessionId)
    if (!current || current.closed) return
    this.flush(sessionId, current.turnId)
    this.append(sessionId, current.turnId, newItem(), 'error', {
      type: 'error',
      message: error.message,
      code: error.stderrTail,
    })
    this.interrupt(sessionId, 'agent_process_died')
  }

  async promptTurn(
    client: AcpClient,
    sessionId: string,
    blocks: acp.ContentBlock[],
    signal?: AbortSignal,
  ) {
    if (client.isPrompting?.(sessionId)) throw new PromptBusyError(sessionId)
    const turnId = this.beginTurn(sessionId)
    let cancelled = false
    const abort = () => {
      cancelled = true
      void client.cancel(sessionId)
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const response = await client.prompt(sessionId, blocks)
      if (cancelled || signal?.aborted) this.interrupt(sessionId)
      else this.endTurn(sessionId, response)
      return response
    } catch (error) {
      if (error instanceof PromptBusyError) throw error
      if (error instanceof Error && error.name === 'AgentProcessDiedError')
        this.processDied(sessionId, error as AgentProcessDiedError)
      else this.interrupt(sessionId, cancelled ? 'cancelled' : 'error')
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
      this.flush(sessionId, turnId)
    }
  }
}

function stateFor(
  turns: Map<string, { subagents: SubagentTurn }>,
  sessionId: string,
) {
  const state = turns.get(sessionId)
  if (!state) throw new Error(`No active turn for ${sessionId}`)
  return state.subagents
}

export function promptTurn(
  normalizer: AcpNormalizer,
  client: AcpClient,
  sessionId: string,
  blocks: acp.ContentBlock[],
  signal?: AbortSignal,
) {
  return normalizer.promptTurn(client, sessionId, blocks, signal)
}

export function normalizeSessionUpdate(
  normalizer: AcpNormalizer,
  notification: acp.SessionNotification,
) {
  return normalizer.handle(notification)
}
