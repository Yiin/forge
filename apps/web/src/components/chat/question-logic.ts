import type { Message } from '@forge/protocol/message'

export type Question = NonNullable<Extract<Message['content'], { type: 'ask_user_question' }>['questions']>[number]
export type PendingQuestion = { questionId: string; question: Question }

export function pendingQuestions(messages: Message[]): PendingQuestion[] {
  const answered = new Set(
    messages.flatMap((message) => (message.content.type === 'user_answer' ? [message.content.questionId] : [])),
  )
  return messages.flatMap((message) => {
    const content = message.content
    if (content.type !== 'ask_user_question' || answered.has(content.questionId)) return []
    const questions = content.questions ?? (content.question ? [{ question: content.question, options: (content.options ?? []).map((label) => ({ label })) }] : [])
    return questions.map((question) => ({ questionId: content.questionId, question }))
  })
}

export function answerText(answer: unknown): string {
  if (Array.isArray(answer)) return answer.join(', ')
  if (answer && typeof answer === 'object') return Object.values(answer).join(', ')
  return answer == null ? 'Cancelled' : String(answer)
}
