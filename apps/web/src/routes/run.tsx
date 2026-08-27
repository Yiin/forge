import { Link, useParams } from '@tanstack/react-router'
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Copy,
  Pause,
  Play,
  Square,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { statusMeta } from './runs'

type Iteration = {
  id: string
  title: string
  beadId: string
  sessionId: string
  harness: string | null
  model: string | null
  attempt: number
  status: string
  failureReason: string | null
  startedAt: number
  endedAt: number | null
}
type Detail = {
  id: string
  title: string
  status: string
  mode: string
  workerCount: number
  baseBranch: string
  iterationCount: number
  iterations: Iteration[]
  frontier: {
    ready: { id: string; title: string; priority: number }[]
    blocked: { id: string; title: string; priority: number }[]
  }
  config: Record<string, unknown>
  provenance: Record<string, string>
}
export function RunRoute() {
  const { runId } = useParams({ from: '/runs/$runId' })
  const [run, setRun] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionState, setActionState] = useState<
    Record<string, 'pending' | 'failed'>
  >({})
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const load = () =>
    void api
      .getRun(runId)
      .then((value) => {
        setRun(value as Detail)
        setError(null)
      })
      .catch((cause) =>
        setError(
          cause instanceof Error ? cause.message : 'Could not load this run.',
        ),
      )
      .finally(() => setLoading(false))
  useEffect(() => {
    load()
    const timer = setInterval(load, 2000)
    return () => clearInterval(timer)
  }, [runId])
  const backLink = (
    <Link
      className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      to="/runs"
    >
      <ArrowLeft className="size-4" />
      All runs
    </Link>
  )
  if (loading && !run)
    return (
      <section className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
        <p
          className="flex items-center gap-2 text-sm text-muted-foreground"
          role="status"
        >
          <Spinner />
          Loading run…
        </p>
      </section>
    )
  if (error && !run)
    return (
      <section className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
        {backLink}
        <div
          className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-4"
          role="alert"
        >
          <strong className="text-sm font-medium text-destructive">
            Could not load this run
          </strong>
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => void load()}
          >
            Retry
          </Button>
        </div>
      </section>
    )
  if (!run) return null
  const action = async (name: 'pause' | 'resume' | 'cancel') => {
    setActionState((current) => ({ ...current, [name]: 'pending' }))
    try {
      await api.runAction(runId, name)
      setActionState((current) => {
        const next = { ...current }
        delete next[name]
        return next
      })
      await load()
      toast.success(name === 'cancel' ? 'Run cancelled.' : `Run ${name}d.`)
    } catch (cause) {
      setActionState((current) => ({ ...current, [name]: 'failed' }))
      toast.error(
        cause instanceof Error ? cause.message : `Could not ${name} run.`,
      )
    }
  }
  const actionButton = (
    name: 'pause' | 'resume' | 'cancel',
    label: string,
    icon: React.ReactNode,
  ) => {
    const state = actionState[name]
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={label}
            disabled={state === 'pending'}
            onClick={() =>
              name === 'cancel' ? setConfirmCancel(true) : void action(name)
            }
          >
            {state === 'pending' ? <Spinner /> : icon}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    )
  }
  const { icon: StatusIcon, variant: statusVariant } = statusMeta(run.status)
  return (
    <section className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      {backLink}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Epic run
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            {run.title || 'Untitled run'}
          </h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            <Badge variant={statusVariant} className="gap-1">
              <StatusIcon className="size-3" />
              {run.status}
            </Badge>
            <span>
              {run.mode} · {run.workerCount} workers · {run.baseBranch}
            </span>
          </div>
        </div>
        <TooltipProvider delayDuration={300}>
          <div className="flex items-center gap-1">
            {run.status === 'running'
              ? actionButton('pause', 'Pause run', <Pause />)
              : run.status === 'paused'
                ? actionButton('resume', 'Resume run', <Play />)
                : null}
            {['running', 'paused'].includes(run.status) &&
              actionButton('cancel', 'Cancel run', <Square />)}
          </div>
        </TooltipProvider>
      </header>
      {(['pause', 'resume', 'cancel'] as const).map((name) =>
        actionState[name] === 'failed' ? (
          <p className="text-sm text-destructive" role="alert" key={name}>
            Could not {name} the run. Try again.
          </p>
        ) : null,
      )}
      {error && (
        <div
          className="flex flex-col gap-2 rounded-lg border p-4"
          role="status"
        >
          <strong className="text-sm font-medium">Live updates paused</strong>
          <p className="text-sm text-muted-foreground">
            {error} Showing the last saved data.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => void load()}
          >
            Retry
          </Button>
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Configuration</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {Object.keys(run.config).length ? (
            Object.keys(run.config).map((key) => (
              <span key={key} className="text-muted-foreground">
                {key}:{' '}
                <span className="text-foreground">
                  {run.provenance[key] ?? 'default'}
                </span>
              </span>
            ))
          ) : (
            <span className="text-muted-foreground">Defaults</span>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Frontier</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <strong className="text-sm">Ready</strong>
            {run.frontier.ready.map((item) => (
              <p key={item.id} className="text-sm text-muted-foreground">
                {item.title}
              </p>
            ))}
            {!run.frontier.ready.length && (
              <p className="text-sm text-muted-foreground">
                No ready children.
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <strong className="text-sm">Blocked</strong>
            {run.frontier.blocked.map((item) => (
              <p key={item.id} className="text-sm text-muted-foreground">
                {item.title}
              </p>
            ))}
            {!run.frontier.blocked.length && (
              <p className="text-sm text-muted-foreground">
                No blocked children.
              </p>
            )}
          </div>
        </CardContent>
      </Card>
      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this run?</AlertDialogTitle>
            <AlertDialogDescription>
              The run will stop. Existing iteration data will remain available.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep running</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={actionState.cancel === 'pending'}
              onClick={() => {
                setConfirmCancel(false)
                void action('cancel')
              }}
            >
              Cancel run
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-baseline gap-2 text-sm">
            Iterations
            <span className="text-xs font-normal text-muted-foreground">
              {run.iterationCount}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {run.iterations.map((item) => (
            <IterationRow
              key={item.id}
              item={item}
              expanded={open === item.id}
              onToggle={() => setOpen(open === item.id ? null : item.id)}
            />
          ))}
          {run.iterations.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Workers have not started.
            </p>
          )}
        </CardContent>
      </Card>
    </section>
  )
}
function IterationRow({
  item,
  expanded,
  onToggle,
}: {
  item: Iteration
  expanded: boolean
  onToggle: () => void
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(item.sessionId)
      toast.success('Copied session id')
    } catch {
      toast.error('Could not copy session id.')
    }
  }
  const { icon: StatusIcon, variant } = statusMeta(item.status)
  return (
    <Collapsible
      open={expanded}
      onOpenChange={onToggle}
      className="rounded-lg border p-3"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 text-left"
          aria-label={`${item.title || 'Untitled iteration'}, ${item.status}, attempt ${item.attempt}`}
        >
          <Badge variant={variant} className="gap-1">
            <StatusIcon className="size-3" />
          </Badge>
          <span className="flex-1 truncate font-medium">{item.title}</span>
          <span className="text-xs text-muted-foreground">
            attempt {item.attempt}
          </span>
          {expanded ? (
            <ChevronDown className="size-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 text-muted-foreground" />
          )}
        </button>
      </CollapsibleTrigger>
      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <code title="Worker session id" className="font-mono">
          {item.sessionId}
        </code>
        <Button
          variant="ghost"
          size="xs"
          onClick={(event) => {
            event.stopPropagation()
            void copy()
          }}
          aria-label="Copy session id"
        >
          <Copy className="size-3" /> Copy
        </Button>
      </div>
      {item.failureReason && (
        <p className="mt-2 text-sm text-destructive">{item.failureReason}</p>
      )}
      <CollapsibleContent className="mt-2">
        <Transcript sessionId={item.sessionId} />
      </CollapsibleContent>
    </Collapsible>
  )
}
function Transcript({ sessionId }: { sessionId: string }) {
  const [messages, setMessages] = useState<
    Array<{ role?: string; content?: { text?: string } }>
  >([])
  const transcriptRef = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const load = () =>
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`)
      .then((response) => {
        if (!response.ok) throw new Error('Transcript unavailable')
        return response.json()
      })
      .then((value) => {
        setMessages(Array.isArray(value) ? value : [])
        setError(false)
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  useEffect(() => {
    load()
    const timer = setInterval(load, 1000)
    return () => clearInterval(timer)
  }, [sessionId])
  useEffect(() => {
    const element = transcriptRef.current
    if (element && following) element.scrollTop = element.scrollHeight
  }, [messages, following])
  return (
    <>
      <div
        className="max-h-64 overflow-y-auto rounded-lg border bg-card p-3 font-mono text-sm"
        ref={transcriptRef}
        onScroll={(event) => {
          const element = event.currentTarget
          setFollowing(
            element.scrollHeight - element.scrollTop - element.clientHeight <
              32,
          )
        }}
        aria-live="polite"
      >
        {messages.map((message, index) => (
          <p key={index}>
            <strong>{message.role ?? 'event'}</strong>{' '}
            {message.content?.text ?? ''}
          </p>
        ))}
      </div>
      {loading && (
        <p className="mt-1 text-sm text-muted-foreground">
          Loading transcript…
        </p>
      )}
      {!loading && error && (
        <p className="mt-1 text-sm text-destructive">
          Transcript unavailable. Retrying…
        </p>
      )}
      {!loading && !error && messages.length === 0 && (
        <p className="mt-1 text-sm text-muted-foreground">
          No transcript messages yet.
        </p>
      )}
      {!following && (
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() => {
            setFollowing(true)
            transcriptRef.current?.scrollTo({
              top: transcriptRef.current.scrollHeight,
              behavior: 'smooth',
            })
          }}
        >
          Jump to latest
        </Button>
      )}
    </>
  )
}
