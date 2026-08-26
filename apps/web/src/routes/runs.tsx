import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'

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
  const [runs, setRuns] = useState<Run[]>([])
  useEffect(() => {
    void api
      .listRuns()
      .then((value) => setRuns(value as Run[]))
      .catch(() => undefined)
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
      </header>
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
        {runs.length === 0 && <p className="muted">No runs yet.</p>}
      </div>
    </section>
  )
}
function RunCard({ run }: { run: Run }) {
  return (
    <Link className="run-card" to="/runs/$runId" params={{ runId: run.id }}>
      <div className="run-card-title">
        <span className={`status-dot ${run.status}`} />
        {run.title}
      </div>
      <div className="run-card-meta">
        <span>
          {run.iterationCount}/{run.workerCount} iterations
        </span>
        <span>{run.status}</span>
        <span>{elapsed(run.startedAt)}</span>
      </div>
    </Link>
  )
}
