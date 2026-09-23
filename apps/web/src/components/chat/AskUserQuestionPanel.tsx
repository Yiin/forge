import { ShieldAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import {
  pendingQuestionRequests,
  type PendingQuestionRequest,
  type Question,
  type RequestStatus,
} from './question-logic'
import { useMessagesStore } from '../../stores/messages'
import { cn } from '../../lib/utils'

const EMPTY_MESSAGES: never[] = []

/** zeron's question wizard surface: radius 26, glass fill, 150ms fade in. */
const PANEL_CLASS =
  'ask-question-panel mx-auto mb-2 w-full min-w-0 max-w-3xl rounded-[26px] border border-border bg-background shadow-lg backdrop-blur-[16px] duration-150 animate-in fade-in-0 motion-reduce:animate-none dark:bg-surface-raised/72 dark:shadow-none'
const COUNTER_CLASS =
  'inline-flex h-5 shrink-0 items-center rounded-[6px] bg-ink/6 px-1.5 text-[10px] font-medium text-muted-foreground/60 tabular-nums'
const GHOST_BUTTON_CLASS =
  'cursor-pointer rounded-[8px] px-3 py-1.5 text-[13px] text-muted-foreground outline-none transition-colors duration-150 hover:bg-ink/6 hover:text-foreground focus-visible:bg-ink/6 disabled:cursor-default disabled:opacity-40 pointer-coarse:min-h-11'
type SelectedWithText = {
  type: 'selected_with_text'
  optionIds: string[]
  text: string
}
type Answers = Record<string, string | string[] | SelectedWithText>

export function AskUserQuestionPanel({ sessionId }: { sessionId: string }) {
  // The store appends into the per-session array in place and replaces only
  // the record, so subscribe to the record or live replies never re-render.
  const messagesBySession = useMessagesStore((state) => state.bySession)
  const requestsBySession = useMessagesStore(
    (state) => state.snapshotStateBySession,
  )
  const messages = messagesBySession[sessionId] ?? EMPTY_MESSAGES
  const statusRows = requestsBySession[sessionId]?.requests ?? []
  const statuses = new Map(
    statusRows.map((row) => [row.questionId, row.status] as const),
  )
  const requests = pendingQuestionRequests(messages, statuses)
  const answerable = requests.filter(
    (item) =>
      item.requestStatus === 'pending' || item.requestStatus === undefined,
  )
  const request = answerable[0] ?? requests[0]
  if (!request) return null
  return (
    <QuestionCard
      key={request.requestId}
      sessionId={sessionId}
      request={request}
      queued={answerable.reduce(
        (total, item) => total + item.questions.length,
        0,
      )}
    />
  )
}

// Comet advances a single-select question shortly after the click so the
// choice stays visible before the next question replaces it.
const ADVANCE_DELAY_MS = 220

function QuestionCard({
  sessionId,
  request,
  queued,
}: {
  sessionId: string
  request: PendingQuestionRequest
  queued: number
}) {
  const storageKey = `forge:question:${sessionId}:${request.requestId}`
  const [page, setPage] = useState(0)
  const [answers, setAnswers] = useState<Answers>(() =>
    readAnswers(storageKey, request.questions),
  )
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const question = request.questions[page]!
  // A tool approval carries an allow scope. A question that merely arrived on
  // the permission method does not, and must not wear the approval chrome.
  const isPermission =
    request.source === 'permission' && request.permissionScope !== undefined
  const settled = request.requestStatus && request.requestStatus !== 'pending'
  const setAnswer = (value: string | string[] | SelectedWithText): Answers => {
    const next = { ...answers, [question.id!]: value }
    writeAnswers(storageKey, next, request.questions)
    setAnswers(next)
    return next
  }
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
  const isComplete = (values: Answers) =>
    request.questions.every((item) => {
      const answer = values[item.id!]
      if (answer && typeof answer === 'object' && !Array.isArray(answer))
        return answer.optionIds.length > 0 || answer.text.trim().length > 0
      return item.multiSelect
        ? Array.isArray(answer) && answer.length > 0
        : typeof answer === 'string' && answer.trim().length > 0
    })
  const complete = isComplete(answers)
  const submit = async (payload: Answers = answers) => {
    if (!isComplete(payload)) return
    if (advanceTimer.current) clearTimeout(advanceTimer.current)
    advanceTimer.current = null
    setSending(true)
    setError(null)
    try {
      await api.answerQuestion({
        sessionId,
        questionId: request.requestId,
        answers: payload,
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
  useEffect(
    () => () => {
      if (advanceTimer.current) clearTimeout(advanceTimer.current)
    },
    [],
  )
  const advanceAfterSelect = (next: Answers) => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current)
    advanceTimer.current = setTimeout(() => {
      advanceTimer.current = null
      if (page < request.questions.length - 1) setPage(page + 1)
      else void submit(next)
    }, ADVANCE_DELAY_MS)
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
          } else {
            const next = setAnswer(option.id!)
            if (!isPermission) advanceAfterSelect(next)
          }
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        void cancel()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [answers, cancel, freeText, page, question, selectedIds, sending, settled])
  if (!question) return null
  if (settled) {
    // Total over RequestStatus on purpose: a status the server can report but
    // this map omits would render an empty panel instead of failing the build.
    const statusText: Record<RequestStatus, string> = {
      pending: '',
      replying: 'Reply is being delivered.',
      submitted: 'Reply submitted.',
      cancelled: 'This request was cancelled.',
      expired: 'This request expired after the session ended.',
      uncertain:
        'Reply status is uncertain. Reload to check the request state.',
    }
    return (
      <section
        className={cn(
          PANEL_CLASS,
          'px-4 py-4 text-[13px] text-muted-foreground',
        )}
        aria-live="polite"
      >
        {statusText[request.requestStatus!]}
      </section>
    )
  }
  const lastPage = page === request.questions.length - 1
  const advanceDisabled = sending || !canAdvance || (lastPage && !complete)
  const picked =
    selectedIds.length > 0 ||
    (typeof selected === 'string' &&
      selected !== '' &&
      question.options.some((option) => option.id === selected))
  return (
    <section
      className={PANEL_CLASS}
      aria-label={
        isPermission ? 'Tool permission request' : 'Question from Forge'
      }
    >
      <div className="px-4 pt-4">
        <div className="flex items-center gap-2.5">
          <span className="flex min-w-0 items-center gap-1.5 text-[10.5px] font-medium tracking-[0.1em] text-muted-foreground/60 uppercase">
            {isPermission && (
              <ShieldAlert aria-hidden className="size-3.5 text-warning" />
            )}
            <span className="truncate">
              {isPermission
                ? 'Permission request'
                : (question.header ?? 'Forge asks')}
            </span>
          </span>
          {request.questions.length > 1 ? (
            <span aria-live="polite" className={COUNTER_CLASS}>
              <span className="sr-only">Question </span>
              {page + 1}/{request.questions.length}
            </span>
          ) : queued > 1 ? (
            <span aria-live="polite" className={COUNTER_CLASS}>
              {queued} questions
            </span>
          ) : null}
        </div>
        {isPermission && (
          <div className="mt-3 rounded-[12px] border border-warning/25 bg-warning/8 px-3.5 py-2.5 text-[13px]">
            <p className="font-medium text-foreground">
              {request.toolName ?? 'A tool'} needs your approval
            </p>
            {request.toolContext && (
              <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                {request.toolContext}
              </p>
            )}
            <p className="mt-1.5 text-[12px] text-muted-foreground">
              Allow scope: {request.permissionScope ?? 'once'}
            </p>
          </div>
        )}
        <h2 className="mt-1.5 text-[15px] leading-5 font-medium text-foreground">
          {question.question}
        </h2>
        {question.multiSelect && (
          <p className="mt-1 text-[12px] text-muted-foreground/65">
            Select one or more options.
          </p>
        )}
        {error && (
          <p className="mt-2 text-[12px] text-destructive" role="alert">
            {error}
          </p>
        )}
        <QuestionChoices
          question={question}
          value={selected}
          disabled={sending}
          onChange={(value) => {
            const next = setAnswer(value)
            // A permission still needs a deliberate submit, the same way the
            // numbered-key path above refuses to advance on a single choice.
            if (!question.multiSelect && !isPermission) advanceAfterSelect(next)
          }}
        />
        {(question.allowFreeInput || question.options.length === 0) && (
          <div className="mt-3 border-t border-ink/6 px-1 pt-3 pb-1">
            <input
              aria-label="Additional answer"
              type={question.isSecret ? 'password' : 'text'}
              value={
                typeof selected === 'string' && !picked ? selected : freeText
              }
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
              placeholder={
                question.options.length === 0
                  ? 'Type your answer'
                  : picked
                    ? 'Type your own answer, or leave this blank to use the selected option'
                    : 'Type your own answer, or pick an option above'
              }
              onKeyDown={(event) => {
                if (
                  event.key !== 'Enter' ||
                  event.nativeEvent.isComposing ||
                  advanceDisabled
                )
                  return
                event.preventDefault()
                if (!lastPage) setPage(page + 1)
                else void submit()
              }}
              className="w-full border-0 bg-transparent text-[16px] leading-[22.75px] text-foreground caret-primary outline-none placeholder:text-faint-foreground sm:text-[14px]"
            />
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 px-4 pt-1 pb-4">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={cancel}
            disabled={sending}
            className={GHOST_BUTTON_CLASS}
          >
            Cancel
          </button>
          {page > 0 && (
            <button
              type="button"
              onClick={() => setPage(page - 1)}
              disabled={sending}
              className={GHOST_BUTTON_CLASS}
            >
              Back
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => (lastPage ? void submit() : setPage(page + 1))}
          disabled={advanceDisabled}
          className="cursor-pointer rounded-[8px] bg-foreground px-4 py-1.5 text-[13px] font-medium text-background outline-none transition-opacity duration-150 hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-40 pointer-coarse:min-h-11"
        >
          {lastPage ? 'Submit' : 'Next'}
        </button>
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
    <div className="mt-3 flex flex-col gap-1">
      {question.options.map((option, index) => {
        const active = selected.includes(option.id!)
        return (
          <button
            key={option.id}
            type="button"
            className={cn(
              'flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-[12px] border px-3.5 py-2.5 text-left outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default',
              active
                ? 'border-ink/16 bg-ink/9'
                : 'border-transparent bg-ink/2.5 hover:bg-ink/6',
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
            {index < 9 && (
              <span
                aria-hidden
                className={cn(
                  'grid size-[22px] shrink-0 place-items-center rounded-[6px] text-[11px] tabular-nums transition-colors duration-150',
                  active
                    ? 'bg-ink/16 text-foreground'
                    : 'bg-ink/5 text-muted-foreground/60',
                )}
              >
                {index + 1}
              </span>
            )}
            <span className="flex min-w-0 flex-1 flex-col">
              <span
                className={cn(
                  'text-[13.5px] font-medium',
                  active ? 'text-foreground' : 'text-foreground/90',
                )}
              >
                {option.label}
              </span>
              {option.description && (
                <span className="text-[12px] text-muted-foreground">
                  {option.description}
                </span>
              )}
            </span>
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
