import { answerText } from './question-logic'

export function AnsweredQuestionRow({
  question,
  answer,
}: {
  question: string
  answer: unknown
}) {
  return (
    <article className="chat-answered-question mx-auto mb-3 grid max-w-[760px] gap-1 border-l-2 border-primary py-1.5 pl-3 text-muted-foreground">
      <span className="text-xs font-semibold tracking-wide text-primary uppercase">
        Answered
      </span>
      <strong className="font-semibold text-foreground">{question}</strong>
      <span className="text-sm">{answerText(answer)}</span>
    </article>
  )
}
