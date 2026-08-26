import type { Message } from '@forge/protocol/message'
import type { SubagentSession } from './subagent'

export type ToolState = 'running' | 'done' | 'error'
export type ActivityState = ToolState | 'unknown'
export type ChatRenderItem =
  | {
      kind: 'message'
      id: string
      seq: number
      role: 'user' | 'agent'
      text: string
      thought?: boolean
    }
  | {
      kind: 'tool'
      id: string
      name: string
      state: ToolState
      input: unknown
      output?: unknown
    }
  | {
      kind: 'attachment'
      id: string
      filename: string
      path: string
      mime?: string
      sizeBytes?: number
    }
  | { kind: 'answered-question'; id: string; question: string; answer: unknown }
  | {
      kind: 'epic-triage'
      id: string
      card: Extract<Message['content'], { type: 'epic_triage' }>
    }
  | { kind: 'system'; id: string; text: string; code?: string }
  | { kind: 'subagent'; id: string; child: SubagentSession }
  | {
      kind: 'activity'
      id: string
      turnId: string
      tools: Extract<ChatRenderItem, { kind: 'tool' }>[]
      agents: SubagentSession[]
      state: ActivityState
    }

type ActivitySource =
  | Extract<ChatRenderItem, { kind: 'tool' }>
  | Extract<ChatRenderItem, { kind: 'subagent' }>

export function groupActivity(
  items: ChatRenderItem[],
  turnIds: Map<string, string>,
  childTurnIds: Map<string, string>,
): ChatRenderItem[] {
  const result: ChatRenderItem[] = []
  let group: ActivitySource[] = []
  let groupTurnId: string | undefined
  const flush = () => {
    if (!group.length) return
    if (group.length === 1) result.push(group[0])
    else {
      const tools = group.flatMap((entry) =>
        entry.kind === 'tool' ? [entry] : [],
      )
      const agents = group.flatMap((entry) =>
        entry.kind === 'subagent' ? [entry.child] : [],
      )
      const states: ActivityState[] = [
        ...tools.map((tool) => tool.state),
        ...agents.map((agent) =>
          agent.status === 'running'
            ? 'running'
            : agent.status === 'failed' || agent.status === 'errored'
              ? 'error'
              : agent.status === 'completed' || agent.status === 'done'
                ? 'done'
                : 'unknown',
        ),
      ]
      const state = states.includes('error')
        ? 'error'
        : states.includes('running')
          ? 'running'
          : states.includes('unknown')
            ? 'unknown'
            : 'done'
      result.push({
        kind: 'activity',
        id: `activity-${group[0].id}`,
        turnId: groupTurnId ?? 'unknown-turn',
        tools,
        agents,
        state,
      })
    }
    group = []
    groupTurnId = undefined
  }
  for (const item of items) {
    if (item.kind !== 'tool' && item.kind !== 'subagent') {
      flush()
      result.push(item)
      continue
    }
    const turnId =
      item.kind === 'tool'
        ? turnIds.get(item.id)
        : childTurnIds.get(item.child.id)
    if (!group.length || turnId === groupTurnId) {
      group.push(item)
      groupTurnId ??= turnId
    } else {
      flush()
      group.push(item)
      groupTurnId = turnId
    }
  }
  flush()
  return result
}

export function toRenderModel(
  messages: Message[],
  resumedWithRecap = false,
  children: SubagentSession[] = [],
): ChatRenderItem[] {
  const result: ChatRenderItem[] = resumedWithRecap
    ? [{ kind: 'system', id: 'resumed-recap', text: 'Resumed with recap' }]
    : []
  const questions = new Map<string, string>()
  const anchors = new Map<string, number>()
  const turnIds = new Map<string, string>()
  const childTurnIds = new Map<string, string>()
  for (const message of messages) {
    turnIds.set(message.itemId, message.turnId)
    if (message.content.type === 'ask_user_question')
      questions.set(
        message.content.questionId,
        message.content.question ??
          message.content.questions?.[0]?.question ??
          'Question',
      )
    const content = message.content
    if (content.type === 'text_delta' || content.type === 'thought_delta') {
      const previous = result.at(-1)
      if (previous?.kind === 'message' && previous.id === message.itemId) {
        previous.text += content.text
        anchors.set(previous.id, message.seq)
      } else {
        result.push({
          kind: 'message',
          id: message.itemId,
          seq: message.seq,
          role: message.role === 'user' ? 'user' : 'agent',
          text: content.text,
          ...(content.type === 'thought_delta' ? { thought: true } : {}),
        })
        anchors.set(message.itemId, message.seq)
      }
      const current = result.at(-1)
      if (current?.kind === 'message' && current.id === message.itemId)
        current.seq = message.seq
    } else if (
      content.type === 'tool_call' ||
      content.type === 'tool_update' ||
      content.type === 'tool_result'
    ) {
      const previous = result.find(
        (item) => item.kind === 'tool' && item.id === message.itemId,
      )
      if (previous?.kind === 'tool') {
        anchors.set(previous.id, message.seq)
        if (content.type === 'tool_update')
          previous.state = stateForStatus(content.status)
        if (content.type === 'tool_result') {
          previous.output = content.output
          previous.state = content.isError ? 'error' : 'done'
        }
      } else {
        result.push({
          kind: 'tool',
          id: message.itemId,
          name: 'name' in content ? content.name : 'Tool',
          state:
            content.type === 'tool_result'
              ? content.isError
                ? 'error'
                : 'done'
              : content.type === 'tool_update'
                ? stateForStatus(content.status)
                : 'running',
          input: content.type === 'tool_call' ? content.input : undefined,
          output: content.type === 'tool_result' ? content.output : undefined,
        })
        anchors.set(message.itemId, message.seq)
      }
    } else if (content.type === 'attachment_ref') {
      result.push({
        kind: 'attachment',
        id: content.attachmentId,
        filename: content.filename,
        path: content.path,
        mime: content.mime,
        sizeBytes: content.sizeBytes,
      })
    } else if (content.type === 'user_answer') {
      result.push({
        kind: 'answered-question',
        id: message.itemId,
        question: questions.get(content.questionId) ?? 'Question',
        answer: content.cancelled
          ? 'Cancelled'
          : (content.answers ?? content.answer),
      })
    } else if (content.type === 'epic_triage') {
      result.push({ kind: 'epic-triage', id: message.itemId, card: content })
    } else if (content.type === 'turn_interrupted') {
      result.push({
        kind: 'system',
        id: message.itemId,
        text: content.reason
          ? `Turn interrupted: ${content.reason}`
          : 'Turn interrupted',
      })
    } else if (content.type === 'error') {
      result.push({
        kind: 'system',
        id: message.itemId,
        text: content.message,
        ...(content.code ? { code: content.code } : {}),
      })
    }
  }
  const placed = placeSubagents(result, children, anchors) as ChatRenderItem[]
  for (const child of children) {
    const anchor = child.spawnedBySeq
    if (anchor == null) continue
    const anchorItem = messages.find((message) => message.seq === anchor)
    if (anchorItem) childTurnIds.set(child.id, anchorItem.turnId)
  }
  return groupActivity(placed, turnIds, childTurnIds)
}

import { placeSubagents } from './subagent'

function stateForStatus(status: string): ToolState {
  if (/error|fail/i.test(status)) return 'error'
  if (/done|complete|success/i.test(status)) return 'done'
  return 'running'
}
