import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { Dialog, DialogDescription, DialogTitle } from '../components/ui/dialog'
import { StatusPanel } from '../components/ui/status-panel'
import { parseEpicOverrides, type LaunchErrors } from './epic-launch-logic'
import { useNavigate } from '@tanstack/react-router'

type Run = {
  id: string
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
  return (
    <section className="runs-page">
      <header className="runs-heading">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1>Epic runs</h1>
        </div>
        <span>{active.length} active</span>
        <button className="ui-button" onClick={() => setLaunchOpen(true)}>
          Launch epic
        </button>
      </header>
      {error && (
        <div className="state-card state-error" role="alert">
          <strong>Could not load runs</strong>
          <p>{error}</p>
          <button
            className="ui-button"
            onClick={() => window.location.reload()}
          >
            Retry
          </button>
        </div>
      )}
      {active.length > 0 && (
        <div className="run-grid">
          {active.map((run) => (
            <RunCard key={run.id} run={run} />
          ))}
        </div>
      )}
      <h2>History</h2>
      <div className="run-history">
        {runs
          .filter((run) => !active.includes(run))
          .map((run) => (
            <RunCard key={run.id} run={run} />
          ))}
        {loading && <p className="muted">Loading run history…</p>}
        {!loading && !error && runs.length === 0 && (
          <div className="state-card">
            <strong>No run history</strong>
            <p>Launch an epic to see its progress here.</p>
          </div>
        )}
        {!loading &&
          !error &&
          runs.length > 0 &&
          runs.every((run) => active.includes(run)) && (
            <p className="muted">Completed runs will appear here.</p>
          )}
      </div>
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
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Launch an epic"
      description="Choose the project and epic. Advanced overrides are optional."
    >
      <form className="launch-form" onSubmit={(event) => void launch(event)}>
        <div className="launch-heading">
          <p className="eyebrow">Epic runner</p>
          <DialogTitle id="launch-an-epic-title">Launch an epic</DialogTitle>
          <DialogDescription id="launch-an-epic-description">
            Choose the project and epic. Advanced overrides are optional.
          </DialogDescription>
        </div>
        {loadState === 'loading' && (
          <StatusPanel
            status="loading"
            message="Loading projects and harnesses…"
          />
        )}
        {loadState === 'error' && (
          <StatusPanel
            status="error"
            message={loadError}
            onRetry={loadOptions}
          />
        )}
        {loadState === 'ready' && (
          <>
            <label>
              Project
              <select
                aria-invalid={Boolean(fieldError('projectId'))}
                aria-describedby={
                  fieldError('projectId') ? 'launch-project-error' : undefined
                }
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
              {fieldError('projectId') && (
                <small id="launch-project-error" className="field-error">
                  {fieldError('projectId')}
                </small>
              )}
            </label>
            <label>
              Epic id
              <input
                aria-invalid={Boolean(fieldError('epicBeadId'))}
                aria-describedby={
                  fieldError('epicBeadId') ? 'launch-epic-error' : undefined
                }
                value={epicBeadId}
                onChange={(event) => setEpicBeadId(event.target.value)}
                placeholder="forge-3b7"
              />
              {fieldError('epicBeadId') && (
                <small id="launch-epic-error" className="field-error">
                  {fieldError('epicBeadId')}
                </small>
              )}
            </label>
            <div className="launch-fields">
              <label>
                Mode
                <select
                  value={mode}
                  onChange={(event) =>
                    setMode(event.target.value as typeof mode)
                  }
                >
                  <option value="pool">Pool</option>
                  <option value="serial">Serial</option>
                  <option value="auto">Auto</option>
                </select>
              </label>
              <label>
                Workers
                <input
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
                  <small id="launch-workers-error" className="field-error">
                    {fieldError('workerCount')}
                  </small>
                )}
              </label>
              <label>
                Base branch
                <input
                  value={baseBranch}
                  onChange={(event) => setBaseBranch(event.target.value)}
                />
              </label>
            </div>
            <details className="launch-advanced">
              <summary>Advanced overrides</summary>
              <label>
                <span>.forge/epic-run.json overrides</span>
                <textarea
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
                    <small className="field-error" key={key}>
                      {key}: {value}
                    </small>
                  ))}
              </label>
            </details>
            {fieldError('submit') && (
              <p className="field-error" role="alert">
                {fieldError('submit')}
              </p>
            )}
            <div className="launch-actions">
              <button
                type="button"
                className="ui-button"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="ui-button primary"
                disabled={busy}
              >
                {busy ? 'Launching…' : 'Launch epic'}
              </button>
            </div>
          </>
        )}
      </form>
    </Dialog>
  )
}
function RunCard({ run }: { run: Run }) {
  return (
    <Link className="run-card" to="/runs/$runId" params={{ runId: run.id }}>
      <div className="run-card-title">
        <span className={`status-dot ${run.status}`} />
        {run.title || 'Untitled run'}
      </div>
      <div className="run-card-meta">
        <span>{run.iterationCount} iterations</span>
        <span>{run.workerCount} workers</span>
        <span>{run.status}</span>
        <span>{elapsed(run.startedAt)}</span>
      </div>
    </Link>
  )
}
