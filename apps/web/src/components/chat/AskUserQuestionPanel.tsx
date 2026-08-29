import { Check, Send } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../lib/api'
import { pendingQuestions, type PendingQuestion } from './question-logic'
import { useMessagesStore } from '../../stores/messages'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

const EMPTY_MESSAGES: never[] = []

export function AskUserQuestionPanel({ sessionId }: { sessionId: string }) {
  const messages = useMessagesStore(
    (state) => state.bySession[sessionId] ?? EMPTY_MESSAGES,
  )
  const pending = pendingQuestions(messages)
  const current = pending[0]
  if (!current) return null
  return (
    <QuestionCard
      key={`${current.questionId}:${current.question.question}`}
      sessionId={sessionId}
      current={current}
      remaining={pending.length}
    />
  )
}

function QuestionCard({
  sessionId,
  current,
  remaining,
}: {
  sessionId: string
  current: PendingQuestion
  remaining: number
}) {
  const { question } = current
  const [selected, setSelected] = useState<string[]>([])
  const [freeText, setFreeText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const multi = question.multiSelect === true
  const options = question.options
  const submit = async (answer: string | string[]) => {
    if (
      (!Array.isArray(answer) && !answer.trim()) ||
      (Array.isArray(answer) && answer.length === 0)
    )
      return
    setSending(true)
    setError(null)
    try {
      await api.answerQuestion({
        sessionId,
        questionId: current.questionId,
        ...(Array.isArray(answer) ? { answers: answer } : { answer }),
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Answer failed')
    } finally {
      setSending(false)
    }
  }
  const cancel = async () => {
    setSending(true)
    setError(null)
    try {
      await api.cancelQuestion({ sessionId, questionId: current.questionId })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Cancel failed')
    } finally {
      setSending(false)
    }
  }
  const choose = (label: string) => {
    if (multi)
      setSelected((items) =>
        items.includes(label)
          ? items.filter((item) => item !== label)
          : [...items, label],
      )
    else void submit(label)
  }
  return (
    <section
      className="ask-question-panel mx-auto mb-2 w-full min-w-0 max-w-3xl space-y-3 rounded-[20px] border border-border/65 bg-muted/20 p-4"
      aria-label="Question from Forge"
    >
      <div className="flex items-center justify-between text-xs text-muted-foreground/65">
        <span>{question.header ?? 'Forge asks'}</span>
        {remaining > 1 && (
          <span className="flex h-5 items-center rounded-md bg-muted/60 px-1.5 text-[10px] font-medium text-muted-foreground/60 tabular-nums">
            {remaining} questions
          </span>
        )}
      </div>
      <h2 className="text-sm text-foreground/90">{question.question}</h2>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      {options.length > 0 && (
        <div className="space-y-1.5">
          {options.map((option, index) => (
            <button
              type="button"
              className={cn(
                'group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left outline-none transition-all duration-150 focus-visible:border-primary/40 focus-visible:ring-1 focus-visible:ring-primary/25',
                selected.includes(option.label)
                  ? 'border-primary/30 bg-primary/8 text-foreground'
                  : 'border-transparent bg-muted/22 text-foreground/85 hover:border-border/45 hover:bg-muted/34',
                sending ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
              )}
              key={option.label}
              onClick={() => choose(option.label)}
              disabled={sending}
              aria-pressed={multi ? selected.includes(option.label) : undefined}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-medium">
                  {option.label}
                </span>
                {option.description && (
                  <span className="text-xs text-muted-foreground">
                    {option.description}
                  </span>
                )}
              </span>
              {selected.includes(option.label) ? (
                <Check className="size-3.5 shrink-0 text-primary" />
              ) : index < 9 ? (
                <kbd className="flex size-5 shrink-0 items-center justify-center rounded border border-border/50 bg-background/35 text-[11px] font-medium text-muted-foreground/70 tabular-nums transition-colors duration-150 group-hover:border-border/70 group-hover:text-muted-foreground">
                  {index + 1}
                </kbd>
              ) : null}
            </button>
          ))}
        </div>
      )}
      {(options.length === 0 || question.options.length === 0) && (
        <div className="flex items-center gap-2">
          <Input
            aria-label="Answer"
            value={freeText}
            onChange={(event) => setFreeText(event.target.value)}
            placeholder="Type your answer…"
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit(freeText)
            }}
          />
          <Button
            type="button"
            size="icon"
            onClick={() => void submit(freeText)}
            disabled={sending || !freeText.trim()}
            aria-label="Send answer"
          >
            <Send className="size-4" />
          </Button>
        </div>
      )}
      {multi && (
        <Button
          type="button"
          className="w-full"
          onClick={() => void submit(selected)}
          disabled={sending || selected.length === 0}
        >
          Confirm selection
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-muted-foreground"
        onClick={() => void cancel()}
        disabled={sending}
      >
        Cancel
      </Button>
    </section>
  )
}
