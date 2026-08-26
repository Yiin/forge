import { Hono } from 'hono'
import {
  epicCancel,
  epicPause,
  epicResume,
  epicStart,
} from '@forge/protocol/commands'
import type { EpicRunner } from '../epics/runner.js'
import { openChildren, readyChildren, show } from '../epics/beads.js'
import { defaultConfig, resolveRunConfig } from '../config.js'

export type EpicRouteOptions = {
  runner: EpicRunner
  projectPath: (projectId: string) => string | undefined
  config?: (projectId: string) => unknown
  db?: {
    prepare(sql: string): {
      all(...args: unknown[]): any[]
      get(...args: unknown[]): any
    }
  }
}

export function epicRoutes(options: EpicRouteOptions) {
  const app = new Hono()
  const titleFor = async (projectId: string, beadId: string) => {
    const path = options.projectPath(projectId)
    if (!path) return 'Epic run'
    try {
      const description = (await show(path, beadId)).description.trim()
      return (
        description
          .split(/[.!?\n]/, 1)[0]
          ?.trim()
          .slice(0, 96) || 'Epic run'
      )
    } catch {
      return 'Epic run'
    }
  }
  const shape = async (row: any, iterations: any[] = []) => ({
    id: row.id,
    projectId: row.project_id,
    epicBeadId: row.epic_bead_id,
    title: await titleFor(row.project_id, row.epic_bead_id),
    status: row.status,
    mode: row.mode,
    workerCount: row.worker_count,
    baseBranch: row.base_branch,
    config: JSON.parse(row.config ?? '{}'),
    provenance: JSON.parse(row.config ?? '{}').provenance ?? {},
    startedAt: row.started_at,
    endedAt: row.ended_at ?? null,
    error: row.error ?? null,
    iterationCount: iterations.length,
  })
  app.get('/api/epics', async (c) => {
    if (!options.db) return c.json([])
    const rows = options.db
      .prepare('SELECT * FROM epic_runs ORDER BY started_at DESC')
      .all()
    return c.json(await Promise.all(rows.map((row) => shape(row))))
  })
  app.get('/api/epics/:runId', async (c) => {
    if (!options.db) return c.json({ error: 'database unavailable' }, 503)
    const row = options.db
      .prepare('SELECT * FROM epic_runs WHERE id = ?')
      .get(c.req.param('runId'))
    if (!row) return c.json({ error: 'run not found' }, 404)
    const iterations = options.db
      .prepare(
        'SELECT * FROM epic_iterations WHERE epic_run_id = ? ORDER BY started_at',
      )
      .all(row.id)
    const projectPath = options.projectPath(row.project_id)
    const [ready, open] = projectPath
      ? await Promise.all([
          readyChildren(projectPath, row.epic_bead_id),
          openChildren(projectPath, row.epic_bead_id),
        ])
      : [[], []]
    const done = new Set(iterations.map((item) => item.bead_id))
    return c.json({
      ...(await shape(row, iterations)),
      iterations: await Promise.all(
        iterations.map(async (item) => ({
          id: item.id,
          beadId: item.bead_id,
          title: projectPath
            ? (
                await show(projectPath, item.bead_id).catch(() => ({
                  title: 'Untitled iteration',
                }))
              ).title || 'Untitled iteration'
            : 'Untitled iteration',
          sessionId: item.session_id,
          harness: item.harness ?? null,
          model: item.model ?? null,
          attempt: item.attempt,
          status: item.status,
          failureReason: item.failure_reason ?? null,
          startedAt: item.started_at,
          endedAt: item.ended_at ?? null,
        })),
      ),
      frontier: {
        ready: ready.map((item) => ({
          id: item.id,
          title: item.title,
          priority: item.priority,
        })),
        blocked: open
          .filter(
            (item) =>
              !done.has(item.id) &&
              !ready.some((readyItem) => readyItem.id === item.id),
          )
          .map((item) => ({
            id: item.id,
            title: item.title,
            priority: item.priority,
          })),
      },
    })
  })
  app.post('/api/epics/start', async (c) => {
    const body = epicStart.parse(await c.req.json())
    const repoPath = options.projectPath(body.projectId)
    if (!repoPath) return c.json({ error: 'project not found' }, 404)
    const resolved = await resolveRunConfig(
      repoPath,
      body.config,
      defaultConfig().settings.epicDefaults,
    )
    const run = await options.runner.startRun({
      ...body,
      repoPath,
      config: options.config?.(body.projectId) ?? resolved,
    })
    return c.json(run, 202)
  })
  app.post('/api/epics/:runId/pause', async (c) => {
    await options.runner.pause(
      epicPause.parse({ runId: c.req.param('runId') }).runId,
    )
    return c.json({ ok: true })
  })
  app.post('/api/epics/:runId/cancel', async (c) => {
    await options.runner.cancel(
      epicCancel.parse({ runId: c.req.param('runId') }).runId,
    )
    return c.json({ ok: true })
  })
  app.post('/api/epics/:runId/resume', async (c) => {
    const body = epicResume.parse({
      runId: c.req.param('runId'),
      ...(await c.req.json().catch(() => ({}))),
    })
    await options.runner.resume(body.runId, body.skipBead)
    return c.json({ ok: true })
  })
  return app
}
