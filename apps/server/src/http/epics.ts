import { Hono } from 'hono'
import {
  epicCancel,
  epicPause,
  epicResume,
  epicStart,
} from '@forge/protocol/commands'
import type { EpicRunner, StartRunInput } from '../epics/runner.js'

export type EpicRouteOptions = {
  runner: EpicRunner
  projectPath: (projectId: string) => string | undefined
  config?: (projectId: string) => unknown
}

export function epicRoutes(options: EpicRouteOptions) {
  const app = new Hono()
  app.post('/api/epics/start', async (c) => {
    const body = epicStart.parse(await c.req.json())
    const repoPath = options.projectPath(body.projectId)
    if (!repoPath) return c.json({ error: 'project not found' }, 404)
    const run = await options.runner.startRun({
      ...body,
      repoPath,
      config: options.config?.(body.projectId) ?? body.config,
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
    await options.runner.resume(
      epicResume.parse({ runId: c.req.param('runId') }).runId,
    )
    return c.json({ ok: true })
  })
  return app
}
