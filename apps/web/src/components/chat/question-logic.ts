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
    const questions: Question[] =
      content.questions ??
      (content.question
        ? [
            {
              question: content.question,
              options: (content.options ?? []).map((label) => ({ label })),
            } as Question,
          ]
        : [])
    return [
      {
        requestId: content.questionId,
        source: content.source,
        requestStatus: content.requestStatus,
        toolName: content.toolName,
        toolContext: content.toolContext,
        permissionScope: content.permissionScope,
        questions: questions.map((question, index) => ({
          ...question,
          id: question.id ?? `${content.questionId}-${index + 1}`,
          options: question.options.map((option, optionIndex) => ({
            ...option,
            id:
              option.id ??
              `${content.questionId}-${index + 1}-${optionIndex + 1}`,
          })),
        })),
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

export function answerText(answer: unknown): string {
  if (Array.isArray(answer)) return answer.join(', ')
  if (answer && typeof answer === 'object')
    return Object.values(answer).join(', ')
  return answer == null ? 'Cancelled' : String(answer)
}
