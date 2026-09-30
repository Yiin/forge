import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { createProject, createSession } from '../db/queries.js'
import { migrate } from '../db/migrate.js'
import type { EpicRunner } from '../epics/runner.js'
import { epicRoutes } from './epics.js'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

it('returns each iteration with its worker session title', async () => {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  migrate(db)
  const project = createProject(db, { name: 'epic', path: '/tmp/epic' })
  db.prepare(
    "INSERT INTO epic_runs(id,project_id,epic_bead_id,status,mode,worker_count,base_branch,config,started_at) VALUES ('run-1',?,'forge-1','running','serial',1,'main','{}',1)",
  ).run(project.id)
  const worker = createSession(db, {
    projectId: project.id,
    harness: 'fake',
    cwd: '/tmp/epic',
    title: 'Generated worker title',
    kind: 'epic_worker',
  })
  // Worker sessions carry the run id too, so the query must not be ambiguous.
  db.prepare('UPDATE sessions SET epic_run_id = ? WHERE id = ?').run(
    'run-1',
    worker.id,
  )
  db.prepare(
    "INSERT INTO epic_iterations(id,epic_run_id,bead_id,session_id,worktree_path,branch,attempt,status,started_at,radar_nudges) VALUES ('it-1','run-1','forge-1.1',?,'/tmp/w','b',1,'running',2,0)",
  ).run(worker.id)
  const app = epicRoutes({
    runner: {} as EpicRunner,
    projectPath: () => undefined,
    db,
  })
  const response = await app.request('/api/epics/run-1')
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    iterations: Array<{ sessionTitle: string | null }>
  }
  expect(body.iterations[0]?.sessionTitle).toBe('Generated worker title')
})
