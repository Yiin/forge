import type { Message } from '@forge/protocol/message'
import type { NativeInteraction } from '@forge/protocol/ws'

export type Question = NonNullable<
  Extract<Message['content'], { type: 'ask_user_question' }>['questions']
>[number]
export type PendingQuestion = {
  requestId: string
  questionId: string
  question: Question
  index: number
}
export type PendingQuestionRequest = {
  requestId: string
  source?: 'permission' | 'ext'
  // A snapshot row overrides the stored content status, so this takes the wire
  // status set. It is wider: stored content never carries 'cancelled'.
  requestStatus?: NativeInteraction['status']
  toolName?: string
  toolContext?: string
  permissionScope?: 'once' | 'session'
  questions: Question[]
}

export type RequestStatus = NonNullable<PendingQuestionRequest['requestStatus']>

type AskContent = Extract<Message['content'], { type: 'ask_user_question' }>

// Legacy rows carry one bare question and label-only options. Replies address
// options by ID, so every question and option gets a stable synthetic ID here
// and everywhere else that has to match a stored reply back to its labels.
export function requestQuestions(content: AskContent): Question[] {
  const questions: Question[] =
    content.questions ??
    (content.question
      ? [
          {
            question: content.question,
            options: (content.options ?? []).map((label) => ({ label })),
            allowFreeInput: (content.options ?? []).length === 0,
          } as Question,
        ]
      : [])
  return questions.map((question, index) => ({
    ...question,
    id: question.id ?? `${content.questionId}-${index + 1}`,
    options: question.options.map((option, optionIndex) => ({
      ...option,
      id: option.id ?? `${content.questionId}-${index + 1}-${optionIndex + 1}`,
    })),
  }))
}

export function pendingQuestionRequests(
  messages: Message[],
  statuses?: ReadonlyMap<string, RequestStatus>,
): PendingQuestionRequest[] {
  const answered = new Set(
    messages.flatMap((message) =>
      message.content.type === 'user_answer'
        ? [message.content.questionId]
        : [],
    ),
  )
  return messages.flatMap((message) => {
    const content = message.content
    if (
      content.type !== 'ask_user_question' ||
      answered.has(content.questionId)
    )
      return []
    return [
      {
        requestId: content.questionId,
        source: content.source,
        requestStatus:
          statuses?.get(content.questionId) ?? content.requestStatus,
        toolName: content.toolName,
        toolContext: content.toolContext,
        permissionScope: content.permissionScope,
        questions: requestQuestions(content),
      },
    ]
  })
}

export function pendingQuestions(messages: Message[]): PendingQuestion[] {
  return pendingQuestionRequests(messages).flatMap((request) =>
    request.questions.map((question, index) => ({
      requestId: request.requestId,
      questionId: request.requestId,
      question,
      index,
    })),
  )
}

const labelsOf = (questions: Question[]): Map<string, string> =>
  new Map(
    questions.flatMap((question) =>
      question.options.map((option) => [option.id!, option.label] as const),
    ),
  )

const isSelectedWithText = (answer: unknown) =>
  !!answer &&
  typeof answer === 'object' &&
  !Array.isArray(answer) &&
  (answer as Record<string, unknown>).type === 'selected_with_text'

function withLabels(labels: Map<string, string>, answer: unknown): unknown {
  if (typeof answer === 'string') return labels.get(answer) ?? answer
  if (Array.isArray(answer))
    return answer.map((item) => withLabels(labels, item))
  if (isSelectedWithText(answer)) {
    const record = answer as Record<string, unknown>
    return [
      ...(Array.isArray(record.optionIds)
        ? record.optionIds.map((id) => withLabels(labels, id))
        : []),
      record.text,
    ].filter((item) => typeof item === 'string' && item.trim().length > 0)
  }
  return answer
}

// A stored reply holds option IDs. History has to read as the labels the user
// clicked, so swap every known ID back before the answer is rendered. Two
// questions in one request may reuse an option ID for different labels, so a
// per-question reply resolves against its own question.
export function answerWithLabels(
  questions: Question[] | undefined,
  answer: unknown,
): unknown {
  const all = questions ?? []
  if (
    !answer ||
    typeof answer !== 'object' ||
    Array.isArray(answer) ||
    isSelectedWithText(answer)
  )
    return withLabels(labelsOf(all), answer)
  return Object.fromEntries(
    Object.entries(answer as Record<string, unknown>).map(([key, value]) => {
      const question = all.find((item) => item.id === key)
      return [key, withLabels(labelsOf(question ? [question] : all), value)]
    }),
  )
}

export function answerText(answer: unknown): string {
  // One reply per question, and a multi-select reply is itself a list, so
  // flatten before joining or the inner list loses its separators.
  if (Array.isArray(answer)) return answer.flat(Infinity).join(', ')
  if (answer && typeof answer === 'object')
    return Object.values(answer).flat(Infinity).join(', ')
  return answer == null ? 'Cancelled' : String(answer)
}
