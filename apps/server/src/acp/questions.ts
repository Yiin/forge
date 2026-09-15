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
    id?: string
    header?: string
    question: string
    options: QuestionOption[]
    multiSelect?: boolean
    allowFreeInput?: boolean
    isSecret?: boolean
  }>
  source: 'permission' | 'ext'
  toolName?: string
  toolContext?: string
  permissionScope?: 'once' | 'session'
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
  return value.flatMap((entry, questionIndex) => {
    const item = object(entry)
    const question =
      typeof item.question === 'string'
        ? item.question
        : typeof item.prompt === 'string'
          ? item.prompt
          : undefined
    if (!question || !Array.isArray(item.options)) return []
    const options = item.options.flatMap((option, optionIndex) => {
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
              id:
                typeof value.id === 'string'
                  ? value.id
                  : `option-${questionIndex}-${optionIndex}`,
              ...(typeof value.value === 'string'
                ? { value: value.value }
                : {}),
            },
          ]
        : []
    })
    return [
      {
        id: typeof item.id === 'string' ? item.id : `question-${questionIndex}`,
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
        ...(question.toolName ? { toolName: question.toolName } : {}),
        ...(question.toolContext ? { toolContext: question.toolContext } : {}),
        ...(question.permissionScope
          ? { permissionScope: question.permissionScope }
          : {}),
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
        .flatMap((question) =>
          question.id ? [question.id, question.question] : [question.question],
        ),
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
    const answerMap = answer as Record<string, unknown>
    const allowed = new Set(
      held.questions.flatMap((question) =>
        question.id ? [question.id, question.question] : [question.question],
      ),
    )
    const unknown = Object.keys(answerMap).find((key) => !allowed.has(key))
    if (unknown) throw new QuestionError(400, `Unknown answer key: ${unknown}`)
    for (const question of held.questions) {
      const idKey =
        question.id !== undefined && answerMap[question.id] !== undefined
      const value = idKey
        ? answerMap[question.id!]
        : answerMap[question.question]
      if (value === undefined)
        throw new QuestionError(400, `Missing answer key: ${question.question}`)
      if (!idKey) continue
      if (value === null)
        throw new QuestionError(400, `Invalid answer for ${question.question}`)
      const answerObject = object(value)
      if (
        answerObject.type === 'selected_with_text' &&
        typeof answerObject.text !== 'string'
      )
        throw new QuestionError(400, `Invalid answer for ${question.question}`)
      const optionIds: unknown = Array.isArray(value)
        ? value
        : typeof value === 'string' &&
            question.options.length > 0 &&
            !question.allowFreeInput
          ? [value]
          : answerObject.type === 'selected_with_text'
            ? answerObject.optionIds
            : undefined
      if (
        answerObject.type === 'selected_with_text' &&
        !Array.isArray(optionIds)
      )
        throw new QuestionError(400, `Invalid answer for ${question.question}`)
      if (!Array.isArray(optionIds)) continue
      if (
        optionIds.some(
          (optionId) =>
            typeof optionId !== 'string' ||
            !question.options.some((option) => option.id === optionId),
        )
      )
        throw new QuestionError(400, `Invalid option for ${question.question}`)
      if (!question.multiSelect && optionIds.length > 1)
        throw new QuestionError(
          400,
          `Multiple options for ${question.question}`,
        )
    }
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
    forgeSessionId = request.sessionId,
  ): Promise<acp.RequestPermissionResponse> {
    const questions = normalizeQuestions(
      object(request.toolCall.rawInput).questions,
    )
    // A request that carries its own questions is a question, even though it
    // arrived on the permission method. Only the bare form is a tool approval,
    // so only the bare form gets the tool name, context and allow scope.
    const question: PendingQuestion = {
      questionId: id(),
      sessionId: forgeSessionId,
      source: 'permission',
      raw: request as unknown as Record<string, unknown>,
      ...(questions.length
        ? { questions }
        : {
            questions: [
              {
                id: 'permission',
                question: request.toolCall.title ?? 'Question',
                options: request.options.map((option) => ({
                  id: option.optionId,
                  label: option.name,
                })),
              },
            ],
            toolName: request.toolCall.title ?? undefined,
            toolContext: JSON.stringify(request.toolCall.rawInput ?? null),
            permissionScope: request.options.some(
              (option) => option.kind === 'allow_always',
            )
              ? ('session' as const)
              : ('once' as const),
          }),
    }
    return this.hold(question, (value) => {
      if (value === undefined)
        return { outcome: { outcome: 'cancelled' as const } }
      const values = object(value)
      const answer = values.answers ?? values.answer ?? value
      const answerValues = object(answer)
      let first: unknown = Array.isArray(answer)
        ? (answer as unknown[])[0]
        : answer && typeof answer === 'object' && !Array.isArray(answer)
          ? answerValues.optionIds
            ? answer
            : Object.values(answerValues)[0]
          : answer
      if (Array.isArray(first)) first = first[0]
      const optionIds = object(first).optionIds
      const selected =
        first && typeof first === 'object'
          ? Array.isArray(optionIds)
            ? optionIds[0]
            : undefined
          : first
      // The wire only accepts an option the agent offered. A bare approval
      // answers with one of them directly. Kimi packs its questions into
      // rawInput and offers one allow per possible answer, so the chosen answer
      // has to come back as that answer's own option, by name first and by
      // position when the two lists are one allow per answer. A plain approval
      // triple can also match on length, so position alone would answer three
      // choices with a reject. Anything else means the user deliberately
      // answered, so send the narrowest allow, and cancel when there is none.
      const choices = question.questions.flatMap((entry) => entry.options)
      const chosen = choices.findIndex((option) => option.id === selected)
      const oneAllowPerAnswer =
        request.options.length === choices.length &&
        request.options.every((option) => option.kind === 'allow_once')
      const proceed =
        request.options.find((option) => option.optionId === selected) ??
        (chosen >= 0
          ? (request.options.find(
              (option) => option.name === choices[chosen].label,
            ) ?? (oneAllowPerAnswer ? request.options[chosen] : undefined))
          : undefined) ??
        request.options.find((option) => option.kind === 'allow_once') ??
        request.options.find((option) => option.kind === 'allow_always') ??
        request.options.find((option) => option.kind.startsWith('allow'))
      if (!proceed) return { outcome: { outcome: 'cancelled' as const } }
      return {
        outcome: {
          outcome: 'selected' as const,
          optionId: proceed.optionId,
        },
      }
    }) as Promise<acp.RequestPermissionResponse>
  }
  handleExtension(
    method: string,
    params: Record<string, unknown>,
    forgeSessionId?: string,
  ): Promise<Record<string, unknown>> | undefined {
    const classified = classifyQuestion(method, params)
    const question =
      classified && forgeSessionId
        ? { ...classified, sessionId: forgeSessionId }
        : classified
    if (!question) return undefined
    if (
      method !== 'cursor/ask_question' &&
      new Set(question.questions.map((entry) => entry.question)).size !==
        question.questions.length
    )
      throw new Error('Provider cannot represent duplicate question text')
    return this.hold(question, (value) => {
      if (value === undefined) return { outcome: 'cancelled' }
      const answer = typeof value === 'object' ? value : { answer: value }
      if (method === 'cursor/ask_question') return { answers: answer }
      const values = object(answer)
      const answers = Object.fromEntries(
        question.questions.map((entry) => {
          const value =
            values[entry.id ?? ''] ?? values[entry.question] ?? answer
          const combined = object(value)
          const selectedIds = Array.isArray(combined.optionIds)
            ? combined.optionIds.map(String)
            : Array.isArray(value)
              ? value.filter((item): item is string => typeof item === 'string')
              : typeof value === 'string' &&
                  entry.options.some((option) => option.id === value)
                ? [value]
                : undefined
          const optionIds = selectedIds ? new Set(selectedIds) : undefined
          const labels = optionIds
            ? entry.options
                .filter((option) => option.id && optionIds.has(option.id))
                .map((option) => option.label)
            : []
          const text =
            typeof combined.text === 'string' ? combined.text : undefined
          return [
            entry.question,
            optionIds
              ? [...labels, ...(text ? [text] : [])]
              : Array.isArray(value)
                ? value
                : [String(value)],
          ]
        }),
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
