import * as acp from '@zed-industries/agent-client-protocol'
import { appendMessage } from '../db/queries.js'
import type { EventBus } from '../events/bus.js'

export type QuestionOption = {
  label: string
  description?: string
  id?: string
  value?: string
}
export type PendingQuestion = {
  questionId: string
  sessionId: string
  questions: Array<{
    header?: string
    question: string
    options: QuestionOption[]
    multiSelect?: boolean
  }>
  source: 'permission' | 'ext'
  method?: string
  raw: Record<string, unknown>
}

type Db = { prepare(sql: string): any; exec(sql: string): unknown }
type Held = PendingQuestion & {
  resolve: (value: unknown) => void
  answered?: unknown
}
export type QuestionHooks = {
  db: Db
  bus?: EventBus
  turnId?: (sessionId: string) => string
  now?: () => number
}

const id = () =>
  `q_${Date.now().toString(36)}${crypto.randomUUID().replaceAll('-', '')}`
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const normalizeQuestions = (value: unknown): PendingQuestion['questions'] => {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const item = object(entry)
    const question =
      typeof item.question === 'string'
        ? item.question
        : typeof item.prompt === 'string'
          ? item.prompt
          : undefined
    if (!question || !Array.isArray(item.options)) return []
    const options = item.options.flatMap((option) => {
      const value = object(option)
      const label =
        typeof value.label === 'string'
          ? value.label
          : typeof value.name === 'string'
            ? value.name
            : undefined
      return label
        ? [
            {
              label,
              ...(typeof value.description === 'string'
                ? { description: value.description }
                : {}),
              ...(typeof value.id === 'string' ? { id: value.id } : {}),
              ...(typeof value.value === 'string'
                ? { value: value.value }
                : {}),
            },
          ]
        : []
    })
    return [
      {
        ...(typeof item.header === 'string' ? { header: item.header } : {}),
        question,
        options,
        ...(item.multiSelect === true ? { multiSelect: true } : {}),
      },
    ]
  })
}

export function isUserQuestion(request: acp.RequestPermissionRequest): boolean {
  return (
    request.toolCall.title === 'AskUserQuestion' ||
    normalizeQuestions(object(request.toolCall.rawInput).questions).length > 0
  )
}

export function classifyQuestion(
  method: string,
  params: Record<string, unknown>,
): PendingQuestion | undefined {
  if (
    method !== 'cursor/ask_question' &&
    method !== '_x.ai/ask_user_question' &&
    method !== 'x.ai/ask_user_question'
  )
    return undefined
  const wrapped = object(params.params)
  const value = Object.keys(wrapped).length > 0 ? wrapped : params
  const questions = normalizeQuestions(value.questions)
  if (!questions.length) return undefined
  const sessionId =
    typeof value.sessionId === 'string'
      ? value.sessionId
      : typeof params.sessionId === 'string'
        ? params.sessionId
        : undefined
  if (!sessionId) return undefined
  return {
    questionId: typeof value.toolCallId === 'string' ? value.toolCallId : id(),
    sessionId,
    questions,
    source: 'ext',
    method,
    raw: params,
  }
}

export class QuestionManager {
  private readonly pending = new Map<string, Held>()
  private readonly answered = new Map<string, unknown>()
  private readonly now: () => number
  constructor(private readonly hooks: QuestionHooks) {
    this.now = hooks.now ?? Date.now
  }
  get size() {
    return this.pending.size
  }
  private turnId(sessionId: string) {
    return this.hooks.turnId?.(sessionId) ?? `question-${sessionId}`
  }
  private save(question: PendingQuestion) {
    appendMessage(this.hooks.db, {
      sessionId: question.sessionId,
      turnId: this.turnId(question.sessionId),
      itemId: question.questionId,
      role: 'agent',
      type: 'ask_user_question',
      createdAt: this.now(),
      eventBus: this.hooks.bus,
      content: {
        type: 'ask_user_question',
        questionId: question.questionId,
        questions: question.questions,
        question: question.questions[0].question,
        options: question.questions[0].options.map((option) => option.label),
        source: question.source,
      },
    })
  }
  private hold(
    question: PendingQuestion,
    response: (answer: unknown) => unknown,
  ): Promise<unknown> {
    this.save(question)
    return new Promise((resolve) =>
      this.pending.set(`${question.sessionId}:${question.questionId}`, {
        ...question,
        resolve: (value) => resolve(response(value)),
      }),
    )
  }
  handlePermission(
    request: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const questions = normalizeQuestions(
      object(request.toolCall.rawInput).questions,
    )
    const question: PendingQuestion = {
      questionId: id(),
      sessionId: request.sessionId,
      questions: questions.length
        ? questions
        : [{ question: request.toolCall.title ?? 'Question', options: [] }],
      source: 'permission',
      raw: request as unknown as Record<string, unknown>,
    }
    return this.hold(question, (value) => {
      if (value === undefined)
        return { outcome: { outcome: 'cancelled' as const } }
      return {
        outcome: { outcome: 'selected' as const, optionId: String(value) },
      }
    }) as Promise<acp.RequestPermissionResponse>
  }
  handleExtension(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> | undefined {
    const question = classifyQuestion(method, params)
    if (!question) return undefined
    return this.hold(question, (value) => {
      if (value === undefined) return { outcome: 'cancelled' }
      const answer = typeof value === 'object' ? value : { answer: value }
      if (method === 'cursor/ask_question') return { answers: answer }
      const answers = Object.fromEntries(
        question.questions.map((entry) => [
          entry.question,
          Array.isArray(answer) ? answer : [String(answer)],
        ]),
      )
      return { outcome: 'accepted', answers }
    }) as Promise<Record<string, unknown>>
  }
  answerQuestion(sessionId: string, questionId: string, input: unknown) {
    const body =
      typeof input === 'object' && input !== null
        ? object(input)
        : { answer: input }
    const answer = body.answers ?? body.answer
    if (
      typeof answer !== 'string' &&
      !Array.isArray(answer) &&
      (typeof answer !== 'object' || answer === null)
    )
      throw new QuestionError(400, 'Answer is required')
    const key = `${sessionId}:${questionId}`
    const held = this.pending.get(key)
    if (!held) {
      if (this.answered.has(key))
        throw new QuestionError(
          409,
          'Question was already answered',
          this.answered.get(key),
        )
      throw new QuestionError(410, 'Question is no longer pending')
    }
    held.answered = answer
    this.pending.delete(key)
    this.answered.set(key, answer)
    appendMessage(this.hooks.db, {
      sessionId,
      turnId: this.turnId(sessionId),
      itemId: id(),
      role: 'user',
      type: 'user_answer',
      createdAt: this.now(),
      eventBus: this.hooks.bus,
      content: {
        type: 'user_answer',
        questionId,
        ...(body.answer !== undefined ? { answer: body.answer } : {}),
        ...(body.answers !== undefined ? { answers: body.answers } : {}),
      },
    })
    held.resolve(answer)
    return { answer }
  }
  cancelSession(sessionId: string) {
    this.finish(sessionId, undefined, true)
  }
  releaseSession(sessionId: string) {
    this.finish(sessionId, undefined, true)
  }
  private finish(sessionId: string, value: unknown, cancelled: boolean) {
    for (const [key, held] of this.pending)
      if (key.startsWith(`${sessionId}:`)) {
        this.pending.delete(key)
        appendMessage(this.hooks.db, {
          sessionId,
          turnId: this.turnId(sessionId),
          itemId: id(),
          role: 'user',
          type: 'user_answer',
          createdAt: this.now(),
          eventBus: this.hooks.bus,
          content: {
            type: 'user_answer',
            questionId: held.questionId,
            cancelled,
          },
        })
        held.resolve(value)
      }
  }
}

export class QuestionError extends Error {
  constructor(
    readonly status: 400 | 409 | 410,
    message: string,
    readonly original?: unknown,
  ) {
    super(message)
  }
}
