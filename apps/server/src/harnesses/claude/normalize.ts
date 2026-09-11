import { createHash, randomUUID } from 'node:crypto'
import type { TerminalOutcome } from '@forge/protocol/harness'
import {
  Identities,
  LIMITS,
  maybeObject,
  object,
  requiredString,
  string,
  type EmitItem,
  type ObjectValue,
  type Owner,
} from './wire.js'

type Block = {
  index: number
  kind: string
  itemId: string
  text: string
  bytes: number
  inputBytes: number
  full: boolean
  toolId?: string
  name?: string
  input?: unknown
}
type Message = {
  id: string
  owner: Owner
  blocks: Block[]
  bytes: number
  incomplete: boolean
  settled: boolean
  fullCursor: number
  fullFrames: Set<string>
}
type Tool = {
  id: string
  itemId: string
  owner: Owner
  name: string
  finished: boolean
  resultSeen: boolean
}
type Child = {
  owner: Owner
  itemId: string
  toolId: string
  providerId?: string
  finished: boolean
}
const ownerKey = (owner: Owner) => owner.childId ?? owner.turnId
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const syntheticText = (text: string) =>
  /^\s*(\[Request interrupted|<system-reminder>|<local-command-(?:stdout|stderr|caveat)>)/.test(
    text,
  )

/** Ordered content mapping. Process ownership and root completion belong to the session. */
export class ClaudeNormalizer {
  private readonly messages = new Map<string, Message>()
  private readonly current = new Map<string, string>()
  private readonly tools = new Map<string, Tool>()
  private readonly children = new Map<string, Child>()
  private readonly agents = new Map<string, Child>()
  private readonly tasks = new Map<string, Tool>()
  private textBytes = 0
  private inputBytes = 0
  private rootStream?: string
  constructor(
    private readonly emit: EmitItem,
    private readonly ids: Identities,
  ) {}

  get retainedInputBytes() {
    return this.inputBytes
  }
  get state() {
    return {
      messages: [...this.messages.values()].filter((m) => m.incomplete).length,
      textBytes: this.textBytes,
      tools: this.tools.size,
      activeTasks: this.activeTasks(),
    }
  }
  knownMessage(
    frame: ObjectValue,
  ): { owner: Owner; settled: boolean } | undefined {
    const event = maybeObject(frame.event)
    const message = maybeObject(frame.message ?? event.message)
    const id = string(message.id)
    if (id) return this.messages.get(id)
    if (
      frame.type === 'stream_event' &&
      event.type !== 'message_start' &&
      !frame.parent_tool_use_id &&
      this.rootStream
    )
      return this.messages.get(this.rootStream)
    return undefined
  }
  childOwner(frame: ObjectValue): Owner | undefined {
    const request = maybeObject(frame.request)
    const parent = string(
      frame.parent_tool_use_id ?? request.parent_tool_use_id,
    )
    const agent = string(frame.agent_id ?? request.agent_id)
    const toolId = string(request.tool_use_id)
    if (parent) {
      const child = this.children.get(parent)
      if (!child) throw new Error('Claude child attribution is unknown')
      return child.owner
    }
    if (agent) {
      const child = this.agents.get(agent)
      if (child) return child.owner
      const tool = this.tools.get(toolId)
      if (tool?.owner.childId) return tool.owner
      throw new Error('Claude agent attribution is unknown')
    }
    if (toolId) return this.tools.get(toolId)?.owner
    return undefined
  }
  toolOwner(toolId: string) {
    return this.tools.get(toolId)?.owner
  }
  isChildFinished(owner: Owner) {
    return owner.childId
      ? [...this.children.values()].some(
          (c) => c.owner.childId === owner.childId && c.finished,
        )
      : false
  }

  system(frame: ObjectValue) {
    const toolId = string(frame.tool_use_id ?? frame.toolUseId)
    const taskId = string(frame.task_id ?? frame.taskId)
    if (frame.subtype === 'task_started') {
      const child = this.children.get(toolId)
      if (frame.subagent_type) {
        if (!child || !taskId)
          throw new Error('Claude task attribution is unknown')
        const existing = this.agents.get(taskId)
        if (existing && existing !== child)
          throw new Error('Claude changed a child identity')
        if (child.providerId && child.providerId !== taskId)
          throw new Error('Claude changed a child identity')
        if (!child.providerId) {
          this.ids.add(`agent:${taskId}`)
          child.providerId = taskId
          this.agents.set(taskId, child)
          this.emit(child.owner, {
            type: 'child_updated',
            itemId: child.itemId,
            providerChildId: taskId,
            parentToolCallId: toolId,
          })
        }
      } else {
        const tool = this.tools.get(toolId)
        if (tool && taskId && !this.tasks.has(taskId)) {
          if (this.activeTasks() >= LIMITS.tasks)
            throw new Error('Claude task limit exceeded')
          this.ids.add(`task:${taskId}`)
          this.tasks.set(taskId, tool)
        }
      }
    } else if (frame.subtype === 'task_notification') {
      const child = this.children.get(toolId) ?? this.agents.get(taskId)
      const status = string(frame.status)
      const outcome: TerminalOutcome =
        status === 'completed'
          ? { status: 'completed' }
          : ['killed', 'interrupted', 'cancelled'].includes(status)
            ? { status: 'interrupted' }
            : {
                status: 'failed',
                code: 'claude_child_failed',
                message: 'Claude child task failed',
              }
      if (child) this.finishChild(child, outcome)
      else {
        const tool = this.tools.get(toolId) ?? this.tasks.get(taskId)
        if (tool && !tool.finished) {
          tool.finished = true
          this.emit(tool.owner, {
            type: 'tool_update',
            itemId: tool.itemId,
            toolCallId: tool.id,
            status: outcome.status,
            output: frame.summary ?? frame.output,
          })
        }
      }
    }
  }
  content(frame: ObjectValue, owner: Owner) {
    if (this.isChildFinished(owner)) return
    if (frame.type === 'stream_event') this.stream(frame, owner)
    else if (frame.type === 'assistant' || frame.type === 'user')
      this.full(frame, owner)
  }
  finishOwner(owner: Owner) {
    for (const message of this.messages.values())
      if (ownerKey(message.owner) === ownerKey(owner)) {
        message.settled = true
        message.incomplete = false
        for (const block of message.blocks) this.release(message, block)
      }
    // Retain the last stream identity so late deltas cannot reopen settled work.
  }
  close(outcome: TerminalOutcome) {
    for (const child of this.children.values()) this.finishChild(child, outcome)
    this.messages.clear()
    this.current.clear()
    this.tools.clear()
    this.children.clear()
    this.agents.clear()
    this.tasks.clear()
    this.textBytes = 0
    this.inputBytes = 0
    this.rootStream = undefined
  }
  private activeTasks() {
    return (
      [...this.children.values()].filter((c) => !c.finished).length +
      [...new Set(this.tasks.values())].filter((t) => !t.finished).length
    )
  }
  private finishChild(child: Child, outcome: TerminalOutcome) {
    if (child.finished) return
    child.finished = true
    this.emit(child.owner, {
      type: 'child_finished',
      itemId: child.itemId,
      outcome,
    })
    this.finishOwner(child.owner)
  }
  private message(id: string, owner: Owner): Message {
    const known = this.messages.get(id)
    if (known) {
      if (
        ownerKey(known.owner) !== ownerKey(owner) ||
        known.owner.runId !== owner.runId
      )
        throw new Error('Claude changed a message owner')
      return known
    }
    if (this.state.messages >= LIMITS.messages)
      throw new Error('Claude incomplete message limit exceeded')
    this.ids.add(`message:${id}`)
    const message: Message = {
      id,
      owner,
      blocks: [],
      bytes: 0,
      incomplete: true,
      settled: false,
      fullCursor: 0,
      fullFrames: new Set(),
    }
    this.messages.set(id, message)
    return message
  }
  private block(message: Message, index: number, kind: string): Block {
    if (!Number.isSafeInteger(index) || index < 0 || index >= LIMITS.blocks)
      throw new Error('Claude block limit exceeded')
    const existing = message.blocks.find((block) => block.index === index)
    if (existing) {
      if (existing.kind !== kind) throw new Error('Claude changed a block type')
      return existing
    }
    if (message.blocks.length >= LIMITS.blocks)
      throw new Error('Claude block limit exceeded')
    this.ids.add(`block:${message.id}:${index}`)
    const block: Block = {
      index,
      kind,
      itemId: randomUUID(),
      text: '',
      bytes: 0,
      inputBytes: 0,
      full: false,
    }
    message.blocks.push(block)
    return block
  }
  private append(message: Message, block: Block, text: string, role?: 'user') {
    if (block.full || message.settled || !text) return
    const bytes = Buffer.byteLength(text)
    if (
      block.bytes + block.inputBytes + bytes > LIMITS.blockBytes ||
      message.bytes + bytes > LIMITS.messageBytes ||
      this.textBytes + this.inputBytes + bytes > LIMITS.textBytes
    )
      throw new Error('Claude retained text limit exceeded')
    block.text += text
    block.bytes += bytes
    message.bytes += bytes
    this.textBytes += bytes
    if (block.kind === 'text' || block.kind === 'thinking')
      this.emit(message.owner, {
        type: block.kind === 'text' ? 'text_delta' : 'thought_delta',
        itemId: block.itemId,
        providerItemId: message.id,
        text,
        ...(role ? { role } : {}),
      })
  }
  private retainInput(message: Message, block: Block, input: unknown) {
    const bytes = Buffer.byteLength(JSON.stringify(input) ?? '')
    const added = bytes - block.inputBytes
    if (
      block.bytes + bytes > LIMITS.blockBytes ||
      message.bytes + added > LIMITS.messageBytes ||
      this.textBytes + this.inputBytes + added > LIMITS.textBytes
    )
      throw new Error('Claude retained tool input limit exceeded')
    block.input = input
    block.inputBytes = bytes
    message.bytes += added
    this.inputBytes += added
  }
  private release(message: Message, block: Block) {
    this.textBytes -= block.bytes
    message.bytes -= block.bytes + block.inputBytes
    this.inputBytes -= block.inputBytes
    block.inputBytes = 0
    block.bytes = 0
    block.text = ''
    block.input = undefined
  }
  private stream(frame: ObjectValue, owner: Owner) {
    const event = object(frame.event)
    const type = string(event.type)
    if (type === 'ping') return
    const key = ownerKey(owner)
    if (type === 'message_start') {
      const id = string(maybeObject(event.message).id) || randomUUID()
      const message = this.message(id, owner)
      if (!message.settled) {
        this.current.set(key, id)
        if (!owner.childId) this.rootStream = id
      }
      return
    }
    const id = this.current.get(key)
    if (!id) {
      if (type === 'message_stop' || type === 'message_delta') return
      throw new Error('Claude stream has no message owner')
    }
    const message = this.messages.get(id)!
    if (message.settled) return
    if (type === 'message_stop') {
      message.incomplete = message.blocks.some((block) => !block.full)
      return
    }
    if (type === 'content_block_start') {
      const content = object(event.content_block)
      if (!['text', 'thinking', 'tool_use'].includes(string(content.type)))
        return
      const block = this.block(
        message,
        Number(event.index),
        requiredString(content.type),
      )
      if (block.full) return
      if (block.kind === 'tool_use') {
        const toolId = requiredString(content.id)
        const name = requiredString(content.name)
        this.ids.add(`tool:${toolId}`)
        this.ids.add(
          `block-tool-name:${message.id.length}:${message.id}:${block.index}:${name}`,
        )
        this.retainInput(message, block, content.input)
        block.toolId = toolId
        block.name = name
      } else
        this.append(message, block, string(content.text ?? content.thinking))
    } else if (type === 'content_block_delta') {
      const delta = object(event.delta)
      const kind =
        delta.type === 'thinking_delta'
          ? 'thinking'
          : delta.type === 'text_delta'
            ? 'text'
            : delta.type === 'input_json_delta'
              ? 'tool_use'
              : ''
      if (!kind) return
      const block = this.block(message, Number(event.index), kind)
      this.append(
        message,
        block,
        string(delta.text ?? delta.thinking ?? delta.partial_json),
      )
    } else if (type === 'content_block_stop') {
      const block = message.blocks.find((block) => block.index === event.index)
      if (block?.kind === 'tool_use' && block.toolId && block.name) {
        let input = block.input
        if (block.text) {
          try {
            input = JSON.parse(block.text)
          } catch {
            throw new Error('Claude sent invalid tool input')
          }
        }
        this.tool(owner, block.toolId, block.name, input, block.itemId)
        this.release(message, block)
      }
    }
  }
  private full(frame: ObjectValue, owner: Owner) {
    const body = object(frame.message)
    const role = frame.type === 'user' ? 'user' : undefined
    const blocks =
      typeof body.content === 'string'
        ? [{ type: 'text', text: body.content }]
        : body.content
    if (!Array.isArray(blocks) || blocks.length > LIMITS.blocks)
      throw new Error('Claude sent invalid content blocks')
    const id =
      string(body.id) ||
      (role ? randomUUID() : this.current.get(ownerKey(owner))) ||
      randomUUID()
    const message = this.message(id, owner)
    if (message.settled) return
    const uuid = string(frame.uuid)
    const fingerprint = uuid
      ? `frame:${uuid}`
      : `content:${digest(JSON.stringify(blocks))}`
    // A matching streamed block takes precedence over content-only retry detection.
    if (
      message.fullFrames.has(fingerprint) &&
      (uuid ||
        !blocks.some((value) => {
          const content = maybeObject(value)
          return message.blocks.some(
            (block) =>
              !block.full &&
              block.kind === content.type &&
              (block.kind !== 'tool_use' || block.toolId === content.id),
          )
        }))
    )
      return
    this.ids.add(`full:${message.id}:${fingerprint}`)
    message.fullFrames.add(fingerprint)
    for (const value of blocks) {
      const content = object(value)
      const kind = string(content.type)
      if (kind === 'tool_result') {
        const tool = this.tools.get(requiredString(content.tool_use_id))
        if (!tool) throw new Error('Claude tool result attribution is unknown')
        if (ownerKey(tool.owner) !== ownerKey(owner))
          throw new Error('Claude tool result changed owner')
        if (!tool.resultSeen) {
          tool.finished = true
          tool.resultSeen = true
          this.emit(owner, {
            type: 'tool_update',
            itemId: tool.itemId,
            toolCallId: tool.id,
            status: content.is_error ? 'failed' : 'completed',
            output: content.content,
          })
        }
        continue
      }
      if (role && kind !== 'text') continue
      if (!['text', 'thinking', 'tool_use'].includes(kind)) continue
      const text = string(content.text ?? content.thinking)
      if (role && (!owner.childId || syntheticText(text))) continue
      if (frame.error && kind === 'text') continue
      const candidate = message.blocks.find(
        (block) =>
          !block.full &&
          block.kind === kind &&
          (kind !== 'tool_use' || block.toolId === content.id),
      )
      const index =
        candidate?.index ??
        Math.max(
          message.fullCursor,
          ...message.blocks.map((block) => block.index + 1),
          0,
        )
      const block = candidate ?? this.block(message, index, kind)
      message.fullCursor = index + 1
      if (kind === 'tool_use')
        this.tool(
          owner,
          requiredString(content.id),
          requiredString(content.name),
          content.input,
          block.itemId,
        )
      else {
        if (!text.startsWith(block.text))
          throw new Error('Claude full content disagrees with streamed content')
        this.append(message, block, text.slice(block.text.length), role)
      }
      block.full = true
      this.release(message, block)
    }
    message.incomplete = message.blocks.some((block) => !block.full)
  }
  private tool(
    owner: Owner,
    id: string,
    name: string,
    input: unknown,
    itemId: string,
  ) {
    const existing = this.tools.get(id)
    if (existing) {
      if (
        ownerKey(existing.owner) !== ownerKey(owner) ||
        existing.name !== name
      )
        throw new Error('Claude changed a tool owner')
      return
    }
    const childTool = name === 'Agent' || name === 'Task'
    if (childTool && this.activeTasks() >= LIMITS.tasks)
      throw new Error('Claude task limit exceeded')
    this.ids.add(`tool:${id}`)
    this.ids.add(`tool-name:${id.length}:${id}:${name}`)
    this.tools.set(id, {
      id,
      itemId,
      owner,
      name,
      finished: false,
      resultSeen: false,
    })
    this.emit(owner, {
      type: 'tool_started',
      itemId,
      toolCallId: id,
      name,
      input,
    })
    if (childTool) {
      const childId = randomUUID()
      const child: Child = {
        owner: { runId: owner.runId, turnId: owner.turnId, childId },
        itemId: randomUUID(),
        toolId: id,
        finished: false,
      }
      this.children.set(id, child)
      this.emit(child.owner, {
        type: 'child_started',
        itemId: child.itemId,
        parentToolCallId: id,
        ...(owner.childId ? { parentChildId: owner.childId } : {}),
        description: string(maybeObject(input).description) || name,
      })
    }
  }
}
