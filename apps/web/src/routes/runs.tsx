import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import {
  AlertCircle,
  Check,
  Inbox,
  Loader2,
  Play,
  Rocket,
  X,
} from 'lucide-react'
import { api } from '../lib/api'
import { useSessionsStore } from '../stores/sessions'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  EpicLaunchDialog as ExtractedEpicLaunchDialog,
} from '../components/epics/EpicLaunchDialog'
export { EpicLaunchDialog } from '../components/epics/EpicLaunchDialog'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'

type Run = {
  id: string
  projectId: string
  title: string
  status: string
  iterationCount: number
  workerCount: number
  startedAt: number
}
const elapsed = (started: number) => {
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`
}
const STATUS_META: Record<
  string,
  {
    icon: typeof Play
    variant: 'default' | 'secondary' | 'destructive' | 'outline'
  }
> = {
  running: { icon: Play, variant: 'default' },
  paused: { icon: Loader2, variant: 'secondary' },
  completed: { icon: Check, variant: 'secondary' },
  failed: { icon: X, variant: 'destructive' },
  cancelled: { icon: X, variant: 'outline' },
}
export function statusMeta(status: string) {
  return STATUS_META[status] ?? { icon: Loader2, variant: 'outline' as const }
}
export function RunsRoute() {
  const navigate = useNavigate()
  const [runs, setRuns] = useState<Run[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [launchOpen, setLaunchOpen] = useState(false)
  useEffect(() => {
    const load = () =>
      void api
        .listRuns()
        .then((value) => {
          setRuns(value as Run[])
          setError(null)
        })
        .catch((cause) =>
          setError(
            cause instanceof Error ? cause.message : 'Could not load runs.',
          ),
        )
        .finally(() => setLoading(false))
    load()
    const timer = setInterval(load, 2000)
    return () => clearInterval(timer)
  }, [])
  const active = runs.filter((run) =>
    ['running', 'paused'].includes(run.status),
  )
  const history = runs.filter((run) => !active.includes(run))
  return (
    <section className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Workspace
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Epic runs</h1>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="secondary">{active.length} active</Badge>
          <Button onClick={() => setLaunchOpen(true)}>
            <Rocket />
            Launch epic
          </Button>
        </div>
      </header>
      {error && (
        <div
          className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-4"
          role="alert"
        >
          <strong className="flex items-center gap-1.5 text-sm font-medium text-destructive">
            <AlertCircle className="size-4" />
            Could not load runs
          </strong>
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => window.location.reload()}
          >
            Retry
          </Button>
        </div>
      )}
      {active.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {active.map((run) => (
            <RunCard key={run.id} run={run} />
          ))}
        </div>
      )}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-tight">History</h2>
        {loading && (
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <p className="text-sm text-muted-foreground">
              Loading run history…
            </p>
          </div>
        )}
        {!loading && history.length > 0 && (
          <div className="flex flex-col gap-2">
            {history.map((run) => (
              <RunCard key={run.id} run={run} />
            ))}
          </div>
        )}
        {!loading && !error && runs.length === 0 && (
          <Empty className="border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Inbox />
              </EmptyMedia>
              <EmptyTitle>No run history</EmptyTitle>
              <EmptyDescription>
                Launch an epic to see its progress here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {!loading &&
          !error &&
          runs.length > 0 &&
          runs.every((run) => active.includes(run)) && (
            <p className="text-sm text-muted-foreground">
              Completed runs will appear here.
            </p>
          )}
      </section>
      <ExtractedEpicLaunchDialog
        open={launchOpen}
        onOpenChange={setLaunchOpen}
        onStarted={(id) =>
          void navigate({ to: '/runs/$runId', params: { runId: id } })
        }
      />
    </section>
  )
}

function RunCard({ run }: { run: Run }) {
  const projects = useSessionsStore((state) => state.projects)
  const project = projects.find((item) => item.id === run.projectId)
  const { icon: Icon, variant } = statusMeta(run.status)
  return (
    <Link
      className="flex flex-col gap-2 rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50"
      to="/runs/$runId"
      params={{ runId: run.id }}
    >
      <div className="flex items-center gap-2">
        <Badge variant={variant} className="gap-1">
          <Icon className="size-3" />
          {run.status}
        </Badge>
        <span className="truncate font-medium">
          {run.title || 'Untitled run'}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {[
          project?.name,
          `${run.iterationCount} iterations`,
          `${run.workerCount} workers`,
          `${elapsed(run.startedAt)} ago`,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
    </Link>
  )
}
