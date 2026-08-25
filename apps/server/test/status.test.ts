import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/events/bus.js'
import { statusRoutes } from '../src/http/status.js'
import { StatusResponse } from '@forge/protocol/status'

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE epic_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    INSERT INTO projects VALUES ('project');
    INSERT INTO sessions VALUES ('idle', 'idle'), ('running', 'running'), ('error', 'errored');
    INSERT INTO epic_runs VALUES ('run', 'running'), ('paused', 'paused');
  `)
  return db
}

describe('dashboard status routes', () => {
  it('returns zod-valid health and counts', async () => {
    const app = statusRoutes({
      db: fixture(),
      bus: new EventBus(),
      version: 'dev',
      bootId: 'boot',
    })
    const health = await app.request('/api/health')
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true, version: 'dev', db: 'ok' })
    const response = await app.request('/api/status')
    const status = StatusResponse.parse(await response.json())
    expect(status.projects).toBe(1)
    expect(status.sessions).toEqual({ idle: 1, running: 1, errored: 1 })
    expect(status.epicRuns).toEqual({ running: 1, paused: 1 })
  })

  it('sends a snapshot and live status event, then unsubscribes on abort', async () => {
    const bus = new EventBus()
    const app = statusRoutes({
      db: fixture(),
      bus,
      version: 'dev',
      bootId: 'boot',
    })
    const controller = new AbortController()
    const response = await app.request('/api/events', {
      signal: controller.signal,
    })
    const reader = response.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('event: snapshot')
    expect(bus.size).toBe(1)
    bus.publish({
      seq: null,
      type: 'sessionStatus',
      sessionId: 'running',
      status: 'idle',
    })
    const second = new TextDecoder().decode((await reader.read()).value)
    expect(second).toContain('event: session')
    controller.abort()
    await reader.cancel()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(bus.size).toBe(0)
  })
})
