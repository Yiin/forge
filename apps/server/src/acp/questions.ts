import * as acp from '@agentclientprotocol/sdk'
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
    allowFreeInput?: boolean
    isSecret?: boolean
  }>
  source: 'permission' | 'ext'
  method?: string
  raw: Record<string, unknown>
}
export type NativeInteractionStatus =
  'pending' | 'replying' | 'submitted' | 'cancelled' | 'expired' | 'uncertain'
export type NativeInteraction = PendingQuestion & {
  status: NativeInteractionStatus
  runtimeGeneration?: string
  answer?: unknown
  createdAt: number
  updatedAt: number
  expiresAt: number
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
  runtimeGeneration?: string
  expiryMs?: number
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
        ...(item.allowFreeInput === true ? { allowFreeInput: true } : {}),
        ...(item.isSecret === true ? { isSecret: true } : {}),
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
  private readonly expiryMs: number
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  constructor(private readonly hooks: QuestionHooks) {
    this.now = hooks.now ?? Date.now
    this.expiryMs = hooks.expiryMs ?? 5 * 60_000
    // A resolver belongs to one runtime. A new manager cannot safely restore it.
    this.hooks.db
      .prepare(
        `UPDATE native_interactions SET status = 'expired', updated_at = ?
         WHERE status IN ('pending', 'replying')`,
      )
      .run(this.now())
  }
  get size() {
    return this.pending.size
  }
  private turnId(sessionId: string) {
    return this.hooks.turnId?.(sessionId) ?? `question-${sessionId}`
  }
  private save(question: PendingQuestion) {
    const now = this.now()
    const expiresAt = now + this.expiryMs
    this.hooks.db
      .prepare(
        `INSERT INTO native_interactions
          (request_id, session_id, runtime_generation, kind, request, status,
           created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        question.questionId,
        question.sessionId,
        this.hooks.runtimeGeneration ?? null,
        question.source === 'permission' ? 'permission' : 'question',
        JSON.stringify(this.publicRequest(question)),
        now,
        now,
        expiresAt,
      )
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
  private publicRequest(question: PendingQuestion) {
    return {
      ...question,
      raw: undefined,
      questions: question.questions.map((entry) => ({
        ...entry,
        options: entry.options.map(({ value: _value, ...option }) => option),
      })),
    }
  }
  listPending(sessionId?: string): NativeInteraction[] {
    const rows = (
      sessionId
        ? this.hooks.db
            .prepare(
              `SELECT * FROM native_interactions WHERE session_id = ?
             ORDER BY created_at`,
            )
            .all(sessionId)
        : this.hooks.db
            .prepare(`SELECT * FROM native_interactions ORDER BY created_at`)
            .all()
    ) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      ...(JSON.parse(String(row.request)) as PendingQuestion),
      status: row.status as NativeInteractionStatus,
      ...(row.runtime_generation
        ? { runtimeGeneration: String(row.runtime_generation) }
        : {}),
      ...(row.answer !== null && row.answer !== undefined
        ? { answer: JSON.parse(String(row.answer)) }
        : {}),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      expiresAt: Number(row.expires_at),
    }))
  }
  private setStatus(
    sessionId: string,
    requestId: string,
    status: NativeInteractionStatus,
    answer?: unknown,
  ) {
    const row = this.hooks.db
      .prepare(
        'SELECT request FROM native_interactions WHERE session_id = ? AND request_id = ?',
      )
      .get(sessionId, requestId) as { request?: string } | undefined
    const storedAnswer =
      answer === undefined ? undefined : this.redact(row?.request, answer)
    this.hooks.db
      .prepare(
        `UPDATE native_interactions SET status = ?, answer = ?, updated_at = ?
         WHERE session_id = ? AND request_id = ?`,
      )
      .run(
        status,
        storedAnswer === undefined ? null : JSON.stringify(storedAnswer),
        this.now(),
        sessionId,
        requestId,
      )
  }
  private redact(request: string | undefined, answer: unknown) {
    if (!request) return answer
    const saved = JSON.parse(request) as PendingQuestion
    const secretIds = new Set(
      saved.questions
        .filter((question) => (question as { isSecret?: boolean }).isSecret)
        .map((question) => question.question),
    )
    if (!secretIds.size) return answer
    if (
      typeof answer === 'object' &&
      answer !== null &&
      !Array.isArray(answer)
    ) {
      return Object.fromEntries(
        Object.entries(answer as Record<string, unknown>).map(
          ([key, value]) => [
            key,
            secretIds.has(key) || key === 'answer' ? '[redacted]' : value,
          ],
        ),
      )
    }
    return '[redacted]'
  }
  private validateAnswer(held: Held, answer: unknown) {
    if (typeof answer !== 'object' || answer === null || Array.isArray(answer))
      return
    const allowed = new Set(held.questions.map((question) => question.question))
    const unknown = Object.keys(answer).find((key) => !allowed.has(key))
    if (unknown) throw new QuestionError(400, `Unknown answer key: ${unknown}`)
  }
  private hold(
    question: PendingQuestion,
    response: (answer: unknown) => unknown,
  ): Promise<unknown> {
    this.save(question)
    const key = `${question.sessionId}:${question.questionId}`
    const timer = setTimeout(() => {
      const held = this.pending.get(key)
      if (!held) return
      this.pending.delete(key)
      this.setStatus(question.sessionId, question.questionId, 'expired')
      appendMessage(this.hooks.db, {
        sessionId: question.sessionId,
        turnId: this.turnId(question.sessionId),
        itemId: id(),
        role: 'user',
        type: 'user_answer',
        createdAt: this.now(),
        eventBus: this.hooks.bus,
        content: {
          type: 'user_answer',
          questionId: question.questionId,
          expired: true,
        },
      })
      held.resolve(undefined)
    }, this.expiryMs)
    timer.unref?.()
    this.timers.set(key, timer)
    return new Promise((resolve) =>
      this.pending.set(key, {
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
    this.validateAnswer(held, answer)
    held.answered = answer
    this.pending.delete(key)
    clearTimeout(this.timers.get(key))
    this.timers.delete(key)
    this.answered.set(
      key,
      this.redact(JSON.stringify({ questions: held.questions }), answer),
    )
    this.setStatus(sessionId, questionId, 'submitted', answer)
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
        ...(body.answer !== undefined
          ? {
              answer: this.redact(
                JSON.stringify({ questions: held.questions }),
                body.answer,
              ),
            }
          : {}),
        ...(body.answers !== undefined
          ? {
              answers: this.redact(
                JSON.stringify({ questions: held.questions }),
                body.answers,
              ),
            }
          : {}),
      },
    })
    held.resolve(answer)
    return { answer }
  }
  cancelQuestion(sessionId: string, questionId: string) {
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
    this.pending.delete(key)
    clearTimeout(this.timers.get(key))
    this.timers.delete(key)
    this.answered.set(key, undefined)
    this.setStatus(sessionId, questionId, 'cancelled')
    appendMessage(this.hooks.db, {
      sessionId,
      turnId: this.turnId(sessionId),
      itemId: id(),
      role: 'user',
      type: 'user_answer',
      createdAt: this.now(),
      eventBus: this.hooks.bus,
      content: { type: 'user_answer', questionId, cancelled: true },
    })
    held.resolve(undefined)
    return { cancelled: true }
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
        clearTimeout(this.timers.get(key))
        this.timers.delete(key)
        this.setStatus(sessionId, held.questionId, 'cancelled')
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
