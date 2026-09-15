import type { Message } from '@forge/protocol/message'

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
  requestStatus?: 'pending' | 'replying' | 'submitted' | 'expired' | 'uncertain'
  toolName?: string
  toolContext?: string
  permissionScope?: 'once' | 'session'
  questions: Question[]
}

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

export function optionLabels(content: AskContent): Map<string, string> {
  return new Map(
    requestQuestions(content).flatMap((question) =>
      question.options.map((option) => [option.id!, option.label] as const),
    ),
  )
}

export function pendingQuestionRequests(
  messages: Message[],
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
        requestStatus: content.requestStatus,
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

// A stored reply holds option IDs. History has to read as the labels the user
// clicked, so swap every known ID back before the answer is rendered.
export function answerWithLabels(
  labels: Map<string, string> | undefined,
  answer: unknown,
): unknown {
  if (typeof answer === 'string') return labels?.get(answer) ?? answer
  if (Array.isArray(answer))
    return answer.map((item) => answerWithLabels(labels, item))
  if (answer && typeof answer === 'object') {
    const record = answer as Record<string, unknown>
    if (record.type === 'selected_with_text')
      return [
        ...(Array.isArray(record.optionIds)
          ? record.optionIds.map((id) => answerWithLabels(labels, id))
          : []),
        record.text,
      ].filter((item) => typeof item === 'string' && item.trim().length > 0)
    return Object.fromEntries(
      Object.entries(record).map(([key, value]) => [
        key,
        answerWithLabels(labels, value),
      ]),
    )
  }
  return answer
}

export function answerText(answer: unknown): string {
  if (Array.isArray(answer)) return answer.join(', ')
  if (answer && typeof answer === 'object')
    return Object.values(answer).join(', ')
  return answer == null ? 'Cancelled' : String(answer)
}
