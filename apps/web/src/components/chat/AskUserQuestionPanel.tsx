import {
  Check,
  ChevronLeft,
  ChevronRight,
  Send,
  ShieldAlert,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import {
  pendingQuestionRequests,
  type PendingQuestionRequest,
  type Question,
} from './question-logic'
import { useMessagesStore } from '../../stores/messages'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

const EMPTY_MESSAGES: never[] = []
type SelectedWithText = {
  type: 'selected_with_text'
  optionIds: string[]
  text: string
}
type Answers = Record<string, string | string[] | SelectedWithText>

export function AskUserQuestionPanel({ sessionId }: { sessionId: string }) {
  const messages = useMessagesStore(
    (state) => state.bySession[sessionId] ?? EMPTY_MESSAGES,
  )
  const requests = pendingQuestionRequests(messages)
  const request =
    requests.find(
      (item) =>
        item.requestStatus === 'pending' || item.requestStatus === undefined,
    ) ?? requests[0]
  if (!request) return null
  return (
    <QuestionCard
      key={request.requestId}
      sessionId={sessionId}
      request={request}
    />
  )
}

function QuestionCard({
  sessionId,
  request,
}: {
  sessionId: string
  request: PendingQuestionRequest
}) {
  const storageKey = `forge:question:${sessionId}:${request.requestId}`
  const [page, setPage] = useState(0)
  const [answers, setAnswers] = useState<Answers>(() =>
    readAnswers(storageKey, request.questions),
  )
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const question = request.questions[page]!
  const isPermission = request.source === 'permission'
  const settled = request.requestStatus && request.requestStatus !== 'pending'
  const setAnswer = (value: string | string[] | SelectedWithText) =>
    setAnswers((current) => {
      const next = { ...current, [question.id!]: value }
      writeAnswers(storageKey, next, request.questions)
      return next
    })
  useEffect(() => {
    document.getElementById('message-composer')?.blur()
  }, [page])
  const selected =
    answers[question?.id ?? ''] ?? (question?.multiSelect ? [] : '')
  const selectedIds = Array.isArray(selected)
    ? selected
    : typeof selected === 'object'
      ? selected.optionIds
      : []
  const freeText =
    typeof selected === 'object' && !Array.isArray(selected)
      ? selected.text
      : ''
  const canAdvance = question
    ? question.multiSelect
      ? selectedIds.length > 0 || freeText.trim().length > 0
      : String(selected).trim().length > 0
    : false
  const complete = request.questions.every((item) => {
    const answer = answers[item.id!]
    if (answer && typeof answer === 'object' && !Array.isArray(answer))
      return answer.optionIds.length > 0 || answer.text.trim().length > 0
    return item.multiSelect
      ? Array.isArray(answer) && answer.length > 0
      : typeof answer === 'string' && answer.trim().length > 0
  })
  const submit = async () => {
    if (!canAdvance) return
    setSending(true)
    setError(null)
    try {
      await api.answerQuestion({
        sessionId,
        questionId: request.requestId,
        answers,
      })
      sessionStorage.removeItem(storageKey)
      document.getElementById('message-composer')?.focus()
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Reply failed. Try again.',
      )
      setSending(false)
    }
  }
  const cancel = async () => {
    setSending(true)
    setError(null)
    try {
      await api.cancelQuestion({ sessionId, questionId: request.requestId })
      sessionStorage.removeItem(storageKey)
      document.getElementById('message-composer')?.focus()
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Cancel failed. Try again.',
      )
      setSending(false)
    }
  }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !question ||
        settled ||
        sending ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return
      const target = event.target
      if (
        event.isComposing ||
        (target instanceof HTMLElement &&
          (target.isContentEditable ||
            target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.tagName === 'SELECT'))
      )
        return
      if (/^[1-9]$/.test(event.key)) {
        const option = question.options[Number(event.key) - 1]
        if (option) {
          event.preventDefault()
          if (question.multiSelect) {
            const values = selectedIds
            setAnswer(
              question.allowFreeInput && freeText
                ? {
                    type: 'selected_with_text',
                    optionIds: values.includes(option.id!)
                      ? values.filter((value) => value !== option.id)
                      : [...values, option.id!],
                    text: freeText,
                  }
                : values.includes(option.id!)
                  ? values.filter((value) => value !== option.id)
                  : [...values, option.id!],
            )
          } else setAnswer(option.id!)
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        void cancel()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [cancel, freeText, question, selectedIds, sending, settled])
  if (!question) return null
  if (settled) {
    const statusText = {
      pending: '',
      replying: 'Reply is being delivered.',
      submitted: 'Reply submitted.',
      expired: 'This request expired after the session ended.',
      uncertain:
        'Reply status is uncertain. Reload to check the request state.',
    }[request.requestStatus!]
    return (
      <section
        className="ask-question-panel mx-auto mb-2 w-full max-w-3xl rounded-[20px] border border-border/60 bg-muted/20 p-4 text-sm text-muted-foreground"
        aria-live="polite"
      >
        {statusText}
      </section>
    )
  }
  return (
    <section
      className="ask-question-panel mx-auto mb-2 w-full min-w-0 max-w-3xl space-y-3 rounded-[20px] border border-border/65 bg-muted/20 p-4"
      aria-label={
        isPermission ? 'Tool permission request' : 'Question from Forge'
      }
    >
      <div className="flex items-center justify-between text-xs text-muted-foreground/75">
        <span className="flex items-center gap-2 font-medium">
          {isPermission && <ShieldAlert className="size-4 text-amber-500" />}
          {isPermission
            ? 'Permission request'
            : (question.header ?? 'Forge asks')}
        </span>
        {request.questions.length > 1 && (
          <span aria-live="polite">
            Question {page + 1} of {request.questions.length}
          </span>
        )}
      </div>
      {isPermission && (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-sm">
          <p className="font-medium">
            {request.toolName ?? 'A tool'} needs your approval
          </p>
          {request.toolContext && (
            <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
              {request.toolContext}
            </p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            Allow scope: {request.permissionScope ?? 'once'}
          </p>
        </div>
      )}
      <div>
        <h2 className="text-sm font-medium text-foreground/90">
          {question.question}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose an answer, then continue.
        </p>
      </div>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      <QuestionChoices
        question={question}
        value={selected}
        disabled={sending}
        onChange={setAnswer}
      />
      {(question.allowFreeInput || question.options.length === 0) && (
        <Input
          aria-label="Additional answer"
          type={question.isSecret ? 'password' : 'text'}
          value={typeof selected === 'string' ? selected : freeText}
          onChange={(event) =>
            setAnswer(
              question.multiSelect && question.allowFreeInput
                ? {
                    type: 'selected_with_text',
                    optionIds: selectedIds,
                    text: event.target.value,
                  }
                : event.target.value,
            )
          }
          placeholder="Add your own answer"
          onKeyDown={(event) => {
            if (
              event.key !== 'Enter' ||
              event.nativeEvent.isComposing ||
              sending ||
              !canAdvance ||
              (page === request.questions.length - 1 && !complete)
            )
              return
            event.preventDefault()
            if (page < request.questions.length - 1) setPage(page + 1)
            else void submit()
          }}
        />
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={cancel}
          disabled={sending}
        >
          Cancel
        </Button>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setPage(page - 1)}
            disabled={sending || page === 0}
          >
            <ChevronLeft className="size-4" />
            Back
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() =>
              page < request.questions.length - 1
                ? setPage(page + 1)
                : void submit()
            }
            disabled={
              sending ||
              !canAdvance ||
              (page === request.questions.length - 1 && !complete)
            }
          >
            {page === request.questions.length - 1 ? (
              <>
                <Send className="size-4" />
                Submit
              </>
            ) : (
              <>
                Next
                <ChevronRight className="size-4" />
              </>
            )}
          </Button>
        </div>
      </div>
    </section>
  )
}

function QuestionChoices({
  question,
  value,
  disabled,
  onChange,
}: {
  question: Question
  value: string | string[] | SelectedWithText
  disabled: boolean
  onChange: (value: string | string[] | SelectedWithText) => void
}) {
  const selected = Array.isArray(value)
    ? value
    : typeof value === 'object'
      ? value.optionIds
      : [value]
  return (
    <div className="space-y-1.5">
      {question.options.map((option, index) => {
        const active = selected.includes(option.id!)
        return (
          <button
            key={option.id}
            type="button"
            className={cn(
              'group flex min-h-11 w-full items-center gap-3 rounded-lg border px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/40',
              active
                ? 'border-primary/35 bg-primary/10'
                : 'border-transparent bg-muted/25 hover:border-border/55 hover:bg-muted/40',
            )}
            disabled={disabled}
            aria-pressed={question.multiSelect ? active : undefined}
            onClick={() => {
              if (question.multiSelect)
                (() => {
                  const optionIds = active
                    ? selected.filter((item) => item !== option.id)
                    : [...selected.filter(Boolean), option.id!]
                  onChange(
                    typeof value === 'object' && !Array.isArray(value)
                      ? { ...value, optionIds }
                      : optionIds,
                  )
                })()
              else onChange(option.id!)
            }}
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium">{option.label}</span>
              {option.description && (
                <span className="text-xs text-muted-foreground">
                  {option.description}
                </span>
              )}
            </span>
            {active ? (
              <Check className="size-4 shrink-0 text-primary" />
            ) : index < 9 ? (
              <kbd className="flex size-5 shrink-0 items-center justify-center rounded border text-[11px] tabular-nums">
                {index + 1}
              </kbd>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

function readAnswers(key: string, questions: Question[]): Answers {
  try {
    const value = sessionStorage.getItem(key)
    return value ? sanitizeAnswers(JSON.parse(value) as Answers, questions) : {}
  } catch {
    return {}
  }
}
function writeAnswers(key: string, answers: Answers, questions: Question[]) {
  try {
    sessionStorage.setItem(
      key,
      JSON.stringify(sanitizeAnswers(answers, questions)),
    )
  } catch {
    /* storage is optional */
  }
}

function sanitizeAnswers(answers: Answers, questions: Question[]): Answers {
  const secretIds = new Set(
    questions
      .filter((question) => question.isSecret)
      .map((question) => question.id),
  )
  return Object.fromEntries(
    Object.entries(answers).filter(
      ([questionId]) => !secretIds.has(questionId),
    ),
  )
}
