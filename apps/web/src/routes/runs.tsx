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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { parseEpicOverrides, type LaunchErrors } from './epic-launch-logic'

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
      <EpicLaunchDialog
        open={launchOpen}
        onOpenChange={setLaunchOpen}
        onStarted={(id) =>
          void navigate({ to: '/runs/$runId', params: { runId: id } })
        }
      />
    </section>
  )
}

export function EpicLaunchDialog({
  open,
  onOpenChange,
  onStarted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onStarted: (runId: string) => void
}) {
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>(
    [],
  )
  const [harnesses, setHarnesses] = useState<Record<string, { name?: string }>>(
    {},
  )
  const [projectId, setProjectId] = useState('')
  const [epicBeadId, setEpicBeadId] = useState('')
  const [mode, setMode] = useState<'pool' | 'serial' | 'auto'>('pool')
  const [workerCount, setWorkerCount] = useState('3')
  const [baseBranch, setBaseBranch] = useState('main')
  const [overrides, setOverrides] = useState('')
  const [errors, setErrors] = useState<LaunchErrors>({})
  const [busy, setBusy] = useState(false)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  )
  const [loadError, setLoadError] = useState('')
  const loadOptions = () => {
    setLoadState('loading')
    setLoadError('')
    void Promise.all([api.listProjects(), api.listHarnesses()])
      .then(([projectData, harnessData]) => {
        const nextProjects = projectData as Array<{ id: string; name: string }>
        setProjects(nextProjects)
        setProjectId((current) => current || nextProjects[0]?.id || '')
        setHarnesses(harnessData as Record<string, { name?: string }>)
        setLoadState('ready')
      })
      .catch((cause) => {
        setLoadError(
          cause instanceof Error
            ? cause.message
            : 'Could not load launch options.',
        )
        setLoadState('error')
      })
  }
  useEffect(() => {
    if (!open) return
    loadOptions()
  }, [open])
  const fieldError = (field: string) => errors[field]
  const launch = async (event: React.FormEvent) => {
    event.preventDefault()
    const nextErrors: LaunchErrors = {}
    if (!projectId) nextErrors.projectId = 'Choose a project.'
    if (!epicBeadId.trim()) nextErrors.epicBeadId = 'Enter an epic id.'
    const count = Number(workerCount)
    if (!Number.isInteger(count) || count < 1 || count > 32)
      nextErrors.workerCount = 'Use a whole number from 1 to 32.'
    const parsed = parseEpicOverrides(overrides, Object.keys(harnesses))
    Object.assign(nextErrors, parsed.errors)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return
    setBusy(true)
    try {
      const result = (await api.startRun({
        projectId,
        epicBeadId: epicBeadId.trim(),
        mode,
        workerCount: count,
        baseBranch: baseBranch.trim() || 'main',
        config: parsed.value ?? {},
      })) as { id: string }
      onOpenChange(false)
      onStarted(result.id)
    } catch (cause) {
      setErrors({
        submit: cause instanceof Error ? cause.message : String(cause),
      })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Epic runner
          </p>
          <DialogTitle>Launch an epic</DialogTitle>
          <DialogDescription>
            Choose the project and epic. Advanced overrides are optional.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => void launch(event)}
        >
          {loadState === 'loading' && (
            <div
              className="flex items-center gap-2 text-sm text-muted-foreground"
              role="status"
            >
              <Spinner />
              Loading projects and harnesses…
            </div>
          )}
          {loadState === 'error' && (
            <div className="flex flex-col gap-2" role="alert">
              <p className="text-sm text-destructive">{loadError}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={loadOptions}
              >
                Retry
              </Button>
            </div>
          )}
          {loadState === 'ready' && (
            <>
              <div className="grid gap-2">
                <Label htmlFor="launch-project">Project</Label>
                <Select
                  value={projectId}
                  onValueChange={(value) => setProjectId(value)}
                >
                  <SelectTrigger
                    id="launch-project"
                    aria-invalid={Boolean(fieldError('projectId'))}
                    aria-describedby={
                      fieldError('projectId')
                        ? 'launch-project-error'
                        : undefined
                    }
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {fieldError('projectId') && (
                  <p
                    id="launch-project-error"
                    className="text-sm text-destructive"
                  >
                    {fieldError('projectId')}
                  </p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="launch-epic-id">Epic id</Label>
                <Input
                  id="launch-epic-id"
                  aria-invalid={Boolean(fieldError('epicBeadId'))}
                  aria-describedby={
                    fieldError('epicBeadId') ? 'launch-epic-error' : undefined
                  }
                  value={epicBeadId}
                  onChange={(event) => setEpicBeadId(event.target.value)}
                  placeholder="forge-3b7"
                />
                {fieldError('epicBeadId') && (
                  <p
                    id="launch-epic-error"
                    className="text-sm text-destructive"
                  >
                    {fieldError('epicBeadId')}
                  </p>
                )}
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="grid gap-2">
                  <Label htmlFor="launch-mode">Mode</Label>
                  <Select
                    value={mode}
                    onValueChange={(value) => {
                      if (
                        value === 'pool' ||
                        value === 'serial' ||
                        value === 'auto'
                      ) {
                        setMode(value)
                      }
                    }}
                  >
                    <SelectTrigger id="launch-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pool">Pool</SelectItem>
                      <SelectItem value="serial">Serial</SelectItem>
                      <SelectItem value="auto">Auto</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="launch-workers">Workers</Label>
                  <Input
                    id="launch-workers"
                    type="number"
                    aria-invalid={Boolean(fieldError('workerCount'))}
                    aria-describedby={
                      fieldError('workerCount')
                        ? 'launch-workers-error'
                        : undefined
                    }
                    min="1"
                    max="32"
                    value={workerCount}
                    onChange={(event) => setWorkerCount(event.target.value)}
                  />
                  {fieldError('workerCount') && (
                    <p
                      id="launch-workers-error"
                      className="text-sm text-destructive"
                    >
                      {fieldError('workerCount')}
                    </p>
                  )}
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="launch-branch">Base branch</Label>
                  <Input
                    id="launch-branch"
                    value={baseBranch}
                    onChange={(event) => setBaseBranch(event.target.value)}
                  />
                </div>
              </div>
              <details className="rounded-lg border px-3 py-2">
                <summary className="cursor-pointer text-sm font-medium">
                  Advanced overrides
                </summary>
                <div className="mt-3 grid gap-2">
                  <Label htmlFor="launch-overrides">
                    .forge/epic-run.json overrides
                  </Label>
                  <Textarea
                    id="launch-overrides"
                    className="font-mono text-xs"
                    value={overrides}
                    onChange={(event) => setOverrides(event.target.value)}
                    placeholder={'{"workerCount": 2, "mode": "serial"}'}
                    rows={6}
                    aria-invalid={Object.keys(errors).some((key) =>
                      key.startsWith('$.forge/epic-run.json'),
                    )}
                  />
                  {Object.entries(errors)
                    .filter(([key]) => key.startsWith('$.forge/epic-run.json'))
                    .map(([key, value]) => (
                      <p className="text-sm text-destructive" key={key}>
                        {key}: {value}
                      </p>
                    ))}
                </div>
              </details>
              {fieldError('submit') && (
                <p className="text-sm text-destructive" role="alert">
                  {fieldError('submit')}
                </p>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy && <Spinner />}
                  {busy ? 'Launching…' : 'Launch epic'}
                </Button>
              </DialogFooter>
            </>
          )}
        </form>
      </DialogContent>
    </Dialog>
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
