import { streamSSE } from 'hono/streaming'
import { Hono } from 'hono'
import type { DatabaseSync } from 'node:sqlite'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  HealthResponse,
  StatusEvent,
  StatusResponse,
} from '@forge/protocol/status'
import { EventBus } from '../events/bus.js'

export type StatusOptions = {
  db: DatabaseSync
  bus: EventBus
  version: string
  bootId?: string
  startedAt?: number
  dataDir?: string
  harnesses?: Array<{
    key: string
    protocol: 'acp' | 'pty'
    liveProcesses: number
  }>
}

function count(db: DatabaseSync, table: string, where = '') {
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS count FROM ${table}${where}`)
      .get() as { count: number | bigint }
    return Number(row.count)
  } catch {
    return 0
  }
}

async function directoryBytes(path: string): Promise<number> {
  try {
    const info = await stat(path)
    if (info.isFile()) return info.size
    if (!info.isDirectory()) return 0
    const entries = await readdir(path)
    const sizes = await Promise.all(
      entries.map((entry) => directoryBytes(join(path, entry))),
    )
    return sizes.reduce((total, size) => total + size, 0)
  } catch {
    return 0
  }
}

export function statusRoutes(options: StatusOptions) {
  const startedAt = options.startedAt ?? Date.now()
  const bootId = options.bootId ?? crypto.randomUUID()
  const snapshot = async () =>
    StatusResponse.parse({
      version: options.version,
      bootId,
      uptimeSec: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      projects: count(options.db, 'projects'),
      sessions: {
        idle: count(options.db, 'sessions', " WHERE status = 'idle'"),
        running: count(options.db, 'sessions', " WHERE status = 'running'"),
        errored: count(options.db, 'sessions', " WHERE status = 'errored'"),
      },
      epicRuns: {
        running: count(options.db, 'epic_runs', " WHERE status = 'running'"),
        paused: count(options.db, 'epic_runs', " WHERE status = 'paused'"),
      },
      harnesses: options.harnesses ?? [],
      dataDirBytes: options.dataDir ? await directoryBytes(options.dataDir) : 0,
    })

  const app = new Hono()
  app.get('/api/health', (c) => {
    try {
      options.db.prepare('SELECT 1').get()
      return c.json(
        HealthResponse.parse({
          ok: true,
          version: options.version,
          db: 'ok',
        }),
        200,
      )
    } catch {
      return c.json(
        HealthResponse.parse({
          ok: false,
          version: options.version,
          db: 'error',
        }),
        503,
      )
    }
  })
  app.get('/api/status', async (c) => c.json(await snapshot()))
  app.get('/api/events', async (c) =>
    streamSSE(c, async (stream) => {
      let closed = false
      const send = async (event: StatusEvent) => {
        if (closed) return
        const valid = StatusEvent.parse(event)
        await stream.writeSSE({
          event: valid.type,
          data: JSON.stringify(valid),
        })
      }
      const unsubscribe = options.bus.subscribe((event) => {
        if (event.type === 'sessionStatus')
          void send({
            type: 'session',
            sessionId: event.sessionId,
            status: event.status,
          })
        if (event.type === 'epicRunStatus')
          void send({
            type: 'epicRun',
            runId: event.runId,
            status: event.status,
          })
      })
      const heartbeat = setInterval(
        () => void send({ type: 'heartbeat', ts: new Date().toISOString() }),
        25_000,
      )
      stream.onAbort(() => {
        closed = true
        unsubscribe()
        clearInterval(heartbeat)
      })
      await send({ type: 'snapshot', status: await snapshot() })
      await new Promise<void>(() => {})
    }),
  )
  return app
}
