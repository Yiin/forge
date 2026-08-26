import { answerText } from './question-logic'

export function AnsweredQuestionRow({ question, answer }: { question: string; answer: unknown }) {
  return <article className="chat-answered-question"><span className="chat-answered-label">Answered</span><strong>{question}</strong><span>{answerText(answer)}</span></article>
}
