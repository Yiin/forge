import { MessageCircle } from 'lucide-react'
import { answerText } from './question-logic'

/**
 * zeron's input chip: a 34px quiet card with a chat tile, the question in
 * muted text, and the answer after it. Forge answers can be long free
 * text, so the answer wraps instead of truncating.
 */
export function AnsweredQuestionRow({
  question,
  answer,
}: {
  question: string
  answer: unknown
}) {
  return (
    <div className="py-1">
      <article className="chat-answered-question flex min-h-[34px] w-full items-start gap-2 rounded-[10px] border border-ink/8 bg-ink/[4.5%] px-2 py-1.5 text-xs leading-[18px]">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-ink/9 text-muted-foreground">
          <MessageCircle className="size-3" aria-hidden />
        </span>
        <span
          className="max-w-[45%] shrink-0 truncate pt-px font-medium text-muted-foreground"
          title={question}
        >
          {question}
        </span>
        <span className="min-w-0 flex-1 pt-px break-words whitespace-pre-wrap text-foreground/90">
          {answerText(answer)}
        </span>
      </article>
    </div>
  )
}
