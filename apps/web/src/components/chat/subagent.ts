import type { Message } from '@forge/protocol/message'

export type SubagentStatus =
  'running' | 'done' | 'errored' | 'interrupted' | 'unknown'

export type SubagentSession = {
  id: string
  title: string
  status?: string
  spawnedBySeq?: number | null
}

export function deriveSubagentStatus(
  messages: Message[],
  sessionStatus?: string,
): SubagentStatus {
  const latest = [...messages]
    .reverse()
    .find((message) =>
      ['turn_start', 'turn_end', 'turn_interrupted', 'error'].includes(
        message.content.type,
      ),
    )
  if (latest?.content.type === 'turn_interrupted') return 'interrupted'
  if (latest?.content.type === 'error' || sessionStatus === 'errored')
    return 'errored'
  if (latest?.content.type === 'turn_end') return 'done'
  if (sessionStatus === 'running' || latest?.content.type === 'turn_start')
    return 'running'
  return 'unknown'
}

export function elapsedSeconds(messages: Message[], now = Date.now()) {
  const start = [...messages]
    .reverse()
    .find((message) => message.content.type === 'turn_start')
  if (!start) return 0
  const time = Date.parse(start.createdAt)
  return Number.isFinite(time)
    ? Math.max(0, Math.floor((now - time) / 1000))
    : 0
}

export function resultPreview(messages: Message[]) {
  const text = [...messages]
    .reverse()
    .find(
      (message) =>
        message.content.type === 'text_delta' && message.role === 'agent',
    )
  return text?.content.type === 'text_delta'
    ? text.content.text.trim().replace(/\s+/g, ' ')
    : ''
}

export function toolCount(messages: Message[]) {
  return new Set(
    messages
      .filter((message) =>
        ['tool_call', 'tool_update', 'tool_result'].includes(
          message.content.type,
        ),
      )
      .map((message) =>
        'toolCallId' in message.content
          ? message.content.toolCallId
          : message.itemId,
      ),
  ).size
}

export function placeSubagents(
  items: Array<{ id: string; seq?: number }>,
  children: SubagentSession[],
  anchors?: Map<string, number>,
) {
  const result: Array<
    | { kind: 'subagent'; id: string; child: SubagentSession }
    | (typeof items)[number]
  > = []
  const bySeq = new Map(children.map((child) => [child.spawnedBySeq, child]))
  for (const item of items) {
    result.push(item)
    const child = bySeq.get(anchors?.get(item.id) ?? item.seq)
    if (child)
      result.push({ kind: 'subagent', id: `subagent-${child.id}`, child })
  }
  for (const child of children) {
    if (!items.some((item) => item.seq === child.spawnedBySeq))
      result.push({ kind: 'subagent', id: `subagent-${child.id}`, child })
  }
  return result
}
