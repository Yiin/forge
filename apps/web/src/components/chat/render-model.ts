import type { Message } from '@forge/protocol/message'
import type { SubagentSession } from './subagent'
import type { PendingUserMessage } from '../../stores/messages'
import { interruptReasonText } from './interrupt-copy'
import { answerWithLabels, requestQuestions } from './question-logic'
import { isAgentTool } from './tool-view'

export type ToolState = 'running' | 'done' | 'error'
export type ChatRenderItem =
  | { kind: 'working'; id: string }
  | {
      kind: 'message'
      id: string
      seq: number
      role: 'user' | 'agent'
      text: string
      thought?: boolean
      pending?: boolean
    }
  | {
      kind: 'tool'
      id: string
      name: string
      nativeChildId?: string
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
      kind: 'plan'
      id: string
      explanation?: string
      steps: Array<{
        id: string
        title: string
        status: 'pending' | 'running' | 'completed' | 'failed'
      }>
    }
  | {
      kind: 'epic-triage'
      id: string
      card: Extract<Message['content'], { type: 'epic_triage' }>
    }
  | { kind: 'system'; id: string; text: string; code?: string; alert?: boolean }
  | {
      kind: 'native'
      id: string
      content: Extract<
        Message['content'],
        {
          type:
            | 'content_block'
            | 'source_reference'
            | 'usage'
            | 'usage_snapshot'
            | 'file_change'
            | 'child_updated'
        }
      >
    }
  | { kind: 'subagent'; id: string; child: SubagentSession }
  | { kind: 'tool-group'; id: string; entries: ToolGroupEntry[] }

export type ToolItem = Extract<ChatRenderItem, { kind: 'tool' }>
export type MessageItem = Extract<ChatRenderItem, { kind: 'message' }>
/** A group holds ordinary tools and the thoughts between them. */
export type ToolGroupEntry = ToolItem | MessageItem

/**
 * zeron's grouping: consecutive tools of one turn share a group, a thought
 * joins the group it lands in, and anything else closes it. Subagent spawns
 * never share a group with ordinary tools; they stay standalone cards. A lone
 * tool still gets a group, so every tool run reads the same way.
 */
export function groupTools(
  items: ChatRenderItem[],
  turnIds: Map<string, string>,
): ChatRenderItem[] {
  const result: ChatRenderItem[] = []
  let group: ToolGroupEntry[] = []
  let groupTurnId: string | undefined
  const flush = () => {
    if (group.length)
      result.push({
        kind: 'tool-group',
        id: `tool-group:${group[0].id}`,
        entries: group,
      })
    group = []
    groupTurnId = undefined
  }
  for (const item of items) {
    const joins =
      (item.kind === 'tool' && !isAgentTool(item)) ||
      (item.kind === 'message' && item.thought)
    if (!joins) {
      flush()
      result.push(item)
      continue
    }
    // Empty thinking neither shows nor splits the run around it.
    if (item.kind === 'message' && !item.text.trim()) continue
    const turnId = turnIds.get(item.id)
    if (group.length && turnId !== groupTurnId) flush()
    if (!group.length) groupTurnId = turnId
    group.push(item)
  }
  flush()
  return result
}

export function toRenderModel(
  messages: Message[],
  resumedWithRecap = false,
  children: SubagentSession[] = [],
  pending: PendingUserMessage[] = [],
  childId?: string,
): ChatRenderItem[] {
  const result: ChatRenderItem[] = resumedWithRecap
    ? [{ kind: 'system', id: 'resumed-recap', text: 'Resumed with recap' }]
    : []
  const questions = new Map<string, string>()
  const questionOptions = new Map<string, ReturnType<typeof requestQuestions>>()
  const anchors = new Map<string, number>()
  const turnIds = new Map<string, string>()
  const toolIds = new Map<string, Extract<ChatRenderItem, { kind: 'tool' }>>()
  const planItems = new Map<string, Extract<ChatRenderItem, { kind: 'plan' }>>()
  const textItems = new Map<
    string,
    Extract<ChatRenderItem, { kind: 'message' }>
  >()
  for (const message of messages) {
    const owner =
      'childId' in message.content ? message.content.childId : undefined
    if (message.content.type !== 'child_updated' && owner !== childId) continue
    const channel =
      message.content.type === 'content_snapshot'
        ? message.content.contentType
        : message.content.type === 'text_delta'
          ? 'text'
          : message.content.type === 'thought_delta'
            ? 'thought'
            : ['tool_call', 'tool_update', 'tool_result'].includes(
                  message.content.type,
                )
              ? 'tool'
              : message.content.type
    const renderId = JSON.stringify([
      message.sessionId,
      message.turnId,
      owner ?? null,
      channel,
      message.itemId,
    ])
    turnIds.set(renderId, message.turnId)
    if (message.content.type === 'ask_user_question') {
      questions.set(
        message.content.questionId,
        message.content.question ??
          message.content.questions?.[0]?.question ??
          'Question',
      )
      questionOptions.set(
        message.content.questionId,
        requestQuestions(message.content),
      )
    }
    const content = message.content
    if (content.type === 'content_snapshot' && content.contentType === 'plan') {
      const key = JSON.stringify([
        message.turnId,
        message.itemId,
        owner ?? null,
      ])
      const previous = planItems.get(key)
      if (previous) previous.explanation = content.text
      else {
        const item: Extract<ChatRenderItem, { kind: 'plan' }> = {
          kind: 'plan',
          id: renderId,
          explanation: content.text,
          steps: [],
        }
        planItems.set(key, item)
        result.push(item)
      }
      continue
    }
    if (
      content.type === 'text_delta' ||
      content.type === 'thought_delta' ||
      content.type === 'content_snapshot'
    ) {
      const channel =
        content.type === 'content_snapshot'
          ? content.contentType
          : content.type === 'thought_delta'
            ? 'thought'
            : 'text'
      const key = JSON.stringify([
        message.turnId,
        message.itemId,
        owner ?? null,
        channel,
      ])
      const previous = textItems.get(key)
      if (previous) {
        previous.text =
          content.type === 'content_snapshot'
            ? content.text
            : previous.text + content.text
        previous.seq = message.seq
      } else {
        const item: Extract<ChatRenderItem, { kind: 'message' }> = {
          kind: 'message',
          id: renderId,
          seq: message.seq,
          role: message.role === 'user' ? 'user' : 'agent',
          text: content.text,
          ...(channel === 'thought' ? { thought: true } : {}),
        }
        result.push(item)
        textItems.set(key, item)
      }
      anchors.set(renderId, message.seq)
    } else if (
      content.type === 'tool_call' ||
      content.type === 'tool_update' ||
      content.type === 'tool_result'
    ) {
      const toolId =
        content.type === 'tool_call' ||
        content.type === 'tool_update' ||
        content.type === 'tool_result'
          ? JSON.stringify([message.turnId, owner ?? null, content.toolCallId])
          : undefined
      const previous =
        result.find((item) => item.kind === 'tool' && item.id === renderId) ??
        (content.type !== 'tool_call' ? toolIds.get(toolId ?? '') : undefined)
      if (previous?.kind === 'tool') {
        if (content.nativeChildId !== undefined)
          previous.nativeChildId = content.nativeChildId
        anchors.set(previous.id, message.seq)
        if (content.type === 'tool_update') {
          previous.state = stateForStatus(content.status)
          if (content.output !== undefined) previous.output = content.output
        }
        if (content.type === 'tool_result') {
          previous.output = content.output
          previous.state = content.isError ? 'error' : 'done'
        }
      } else {
        const tool = {
          kind: 'tool',
          id: renderId,
          name: 'name' in content ? content.name : 'Tool',
          nativeChildId: content.nativeChildId,
          state:
            content.type === 'tool_result'
              ? content.isError
                ? 'error'
                : 'done'
              : content.type === 'tool_update'
                ? stateForStatus(content.status)
                : 'running',
          input: content.type === 'tool_call' ? content.input : undefined,
          output:
            content.type === 'tool_result' || content.type === 'tool_update'
              ? content.output
              : undefined,
        } satisfies Extract<ChatRenderItem, { kind: 'tool' }>
        result.push(tool)
        if (toolId) toolIds.set(toolId, tool)
        anchors.set(renderId, message.seq)
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
        id: renderId,
        question: questions.get(content.questionId) ?? 'Question',
        answer: content.expired
          ? 'Expired'
          : content.cancelled
            ? 'Cancelled'
            : answerWithLabels(
                questionOptions.get(content.questionId),
                content.answers ?? content.answer,
              ),
      })
    } else if (content.type === 'epic_triage') {
      result.push({ kind: 'epic-triage', id: renderId, card: content })
    } else if (content.type === 'plan') {
      result.push({
        kind: 'plan',
        id: renderId,
        explanation: content.explanation,
        steps: content.steps,
      })
    } else if (content.type === 'turn_interrupted') {
      result.push({
        kind: 'system',
        id: renderId,
        text: interruptReasonText(content.reason, content.version),
      })
    } else if (content.type === 'error') {
      result.push({
        kind: 'system',
        id: renderId,
        text: content.message,
        alert: true,
        ...(content.code ? { code: content.code } : {}),
      })
    } else if (
      content.type === 'content_block' ||
      content.type === 'source_reference' ||
      content.type === 'usage' ||
      content.type === 'usage_snapshot' ||
      content.type === 'file_change' ||
      content.type === 'child_updated'
    ) {
      result.push({ kind: 'native', id: renderId, content })
    }
  }
  const placed = placeSubagents(result, children, anchors) as ChatRenderItem[]
  return groupTools(
    [
      ...placed,
      ...pending.map((item) => ({
        kind: 'message' as const,
        id: item.itemId,
        seq: Number.MAX_SAFE_INTEGER,
        role: 'user' as const,
        text: item.text,
        pending: true,
      })),
    ],
    turnIds,
  )
}

import { placeSubagents } from './subagent'

function stateForStatus(status: string): ToolState {
  // Codex reports refused and stopped calls as `declined` and `interrupted`;
  // neither will ever finish, so they count as failures, not as running.
  if (/error|fail|declin|interrupt|cancel|reject/i.test(status)) return 'error'
  if (/done|complete|success/i.test(status)) return 'done'
  return 'running'
}
