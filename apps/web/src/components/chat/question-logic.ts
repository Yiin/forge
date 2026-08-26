import type { Message } from '@forge/protocol/message'

export type Question = NonNullable<Extract<Message['content'], { type: 'ask_user_question' }>['questions']>[number]
export type PendingQuestion = { questionId: string; question: Question }

export function pendingQuestions(messages: Message[]): PendingQuestion[] {
  const answered = new Set(
    messages
      .filter((message) => message.content.type === 'user_answer')
      .map((message) => message.content.questionId),
  )
  return messages.flatMap((message) => {
    if (message.content.type !== 'ask_user_question' || answered.has(message.content.questionId)) return []
    const questions = message.content.questions ?? (message.content.question ? [{ question: message.content.question, options: (message.content.options ?? []).map((label) => ({ label })) }] : [])
    return questions.map((question) => ({ questionId: message.content.questionId, question }))
  })
}

export function answerText(answer: unknown): string {
  if (Array.isArray(answer)) return answer.join(', ')
  if (answer && typeof answer === 'object') return Object.values(answer).join(', ')
  return answer == null ? 'Cancelled' : String(answer)
}
