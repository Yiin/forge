import { Check, Send } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../lib/api'
import { pendingQuestions, type PendingQuestion } from './question-logic'
import { useMessagesStore } from '../../stores/messages'

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
    <section className="ask-question-panel" aria-label="Question from Forge">
      <div className="ask-question-meta">
        <span>{question.header ?? 'Forge asks'}</span>
        {remaining > 1 && <span>{remaining} questions</span>}
      </div>
      <h2>{question.question}</h2>
      {error && (
        <p className="ask-question-error" role="alert">
          {error}
        </p>
      )}
      {options.length > 0 && (
        <div className="ask-question-options">
          {options.map((option) => (
            <button
              type="button"
              className={
                selected.includes(option.label)
                  ? 'ask-question-option selected'
                  : 'ask-question-option'
              }
              key={option.label}
              onClick={() => choose(option.label)}
              disabled={sending}
              aria-pressed={multi ? selected.includes(option.label) : undefined}
            >
              <span>
                {selected.includes(option.label) ? <Check size={16} /> : null}
                {option.label}
              </span>
              {option.description && <small>{option.description}</small>}
            </button>
          ))}
        </div>
      )}
      {(options.length === 0 || question.options.length === 0) && (
        <div className="ask-question-free">
          <input
            aria-label="Answer"
            value={freeText}
            onChange={(event) => setFreeText(event.target.value)}
            placeholder="Type your answer…"
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit(freeText)
            }}
          />
          <button
            type="button"
            onClick={() => void submit(freeText)}
            disabled={sending || !freeText.trim()}
            aria-label="Send answer"
          >
            <Send size={16} />
          </button>
        </div>
      )}
      {multi && (
        <button
          type="button"
          className="ask-question-confirm"
          onClick={() => void submit(selected)}
          disabled={sending || selected.length === 0}
        >
          Confirm selection
        </button>
      )}
      <button
        type="button"
        className="ask-question-cancel"
        onClick={() => void cancel()}
        disabled={sending}
      >
        Cancel
      </button>
    </section>
  )
}
