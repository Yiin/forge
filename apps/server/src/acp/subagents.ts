export type Logger = Pick<Console, 'warn'>

export type Subagent = {
  id: string
  type: string
  description: string
  status: 'running' | 'completed' | 'failed' | 'unknown'
}

type SubagentRecord = Subagent & { toolCallId: string; agentId?: string }
export type SubagentTurn = { records: SubagentRecord[] }

const ulid = () =>
  `${Date.now().toString(36)}${crypto.randomUUID().replaceAll('-', '')}`

const object = (value: unknown): globalThis.Record<string, unknown> =>
  value && typeof value === 'object'
    ? (value as globalThis.Record<string, unknown>)
    : {}

const textOf = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).join('')
  const item = object(value)
  if (item.type === 'text' && typeof item.text === 'string') return item.text
  return textOf(item.content)
}

export function createSubagentTurn(): SubagentTurn {
  return { records: [] }
}

function publicRecord(record: SubagentRecord): Subagent {
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    status: record.status,
  }
}

function find(turn: SubagentTurn, toolCallId: string) {
  return turn.records.find((record) => record.toolCallId === toolCallId)
}

export function detectToolCall(
  turn: SubagentTurn,
  value: globalThis.Record<string, unknown>,
): Subagent | undefined {
  const input = object(value.rawInput)
  const title = typeof value.title === 'string' ? value.title : ''
  const isSubagent =
    title === 'Task' ||
    typeof input.subagent_type === 'string' ||
    typeof input.prompt === 'string'
  if (!isSubagent || typeof value.toolCallId !== 'string') return undefined

  const existing = find(turn, value.toolCallId)
  if (existing) return publicRecord(existing)
  const agentId =
    typeof input.agent_id === 'string' ? input.agent_id : undefined
  const duplicate = agentId
    ? turn.records.find((record) => record.agentId === agentId)
    : undefined
  if (duplicate) return publicRecord(duplicate)
  const type =
    typeof input.subagent_type === 'string' ? input.subagent_type : 'subagent'
  const description =
    title || (typeof input.prompt === 'string' ? input.prompt : 'Subagent task')
  const record: SubagentRecord = {
    id: ulid(),
    toolCallId: value.toolCallId,
    agentId,
    type,
    description,
    status: 'running',
  }
  turn.records.push(record)
  return publicRecord(record)
}

export function updateToolCall(
  turn: SubagentTurn,
  value: globalThis.Record<string, unknown>,
  logger: Logger,
): Subagent | undefined {
  if (typeof value.toolCallId !== 'string') return undefined
  const record = find(turn, value.toolCallId)
  if (!record) return undefined

  const text = textOf(value.content ?? value.rawOutput)
  const completion =
    /^agent_id:\s*(\S+)\nactual_subagent_type:\s*(\S+)\nstatus:\s*(completed|failed)/m.exec(
      text,
    )
  if (text.includes('agent_id:') && !completion) {
    logger.warn('Malformed subagent completion signal; ignoring it')
    return publicRecord(record)
  }
  if (completion) {
    record.agentId = completion[1]
    record.type = completion[2]
    record.status = completion[3] as 'completed' | 'failed'
  } else if (value.status === 'completed' || value.status === 'failed') {
    record.status = value.status
  } else if (value.status === 'in_progress' || value.status === 'running') {
    record.status = 'running'
  }
  return publicRecord(record)
}

export function finalizeSubagents(
  turn: SubagentTurn,
): Array<Subagent & { toolCallId: string }> {
  return turn.records
    .filter((record) => record.status === 'running')
    .map((record) => {
      record.status = 'unknown'
      return { ...publicRecord(record), toolCallId: record.toolCallId }
    })
}
