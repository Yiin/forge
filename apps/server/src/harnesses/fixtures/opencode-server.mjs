#!/usr/bin/env node
// Owned process fixture. It never starts a provider or reads native account state.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { renameSync, writeFileSync } from 'node:fs'

const wire = JSON.parse(
  await readFile(new URL('./opencode-wire.json', import.meta.url), 'utf8'),
)
const config = process.env.FORGE_OPENCODE_FIXTURE_CONFIG
  ? JSON.parse(
      await readFile(process.env.FORGE_OPENCODE_FIXTURE_CONFIG, 'utf8'),
    )
  : {}
const cwd = process.cwd()
const auth = `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`
const streams = new Set()
const requests = []
const history = []
const session = {
  id: 'ses_fixture',
  slug: 'fixture',
  projectID: 'fixture',
  directory: cwd,
  title: 'Fixture',
  version: '1.18.26',
  time: { created: 1, updated: 1 },
  model: { providerID: 'fake', id: 'model/a' },
}
let eventId = 0
const report = {
  pid: process.pid,
  args: process.argv.slice(2),
  // Record comparisons, never environment values or generated credentials.
  environmentMatches: Object.entries(config.expectedEnvironment ?? {}).every(
    ([key, value]) => process.env[key] === (value === null ? undefined : value),
  ),
  basicOwned:
    process.env.OPENCODE_SERVER_USERNAME === 'forge' &&
    !!process.env.OPENCODE_SERVER_PASSWORD &&
    process.env.OPENCODE_SERVER_PASSWORD !== 'stale',
  requests,
}
function save() {
  if (!config.report) return
  // Shutdown can interrupt a write; publish only a complete report for cleanup checks.
  const temporary = `${config.report}.tmp`
  writeFileSync(temporary, JSON.stringify(report))
  renameSync(temporary, config.report)
}
save()
if (config.mode === 'exit') process.exit(3)
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const bodyText = Buffer.concat(chunks).toString('utf8')
  const body = bodyText ? JSON.parse(bodyText) : undefined
  const url = new URL(req.url, 'http://fixture')
  const path = url.pathname
  requests.push({
    method: req.method,
    path,
    authenticated: req.headers.authorization === auth,
    directoryMatches:
      decodeURIComponent(req.headers['x-opencode-directory'] ?? '') === cwd,
  })
  save()
  if (req.headers.authorization !== auth) {
    res.writeHead(401).end()
    return
  }
  if (path === '/global/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    streams.add(res)
    res.on('close', () => streams.delete(res))
    res.write(
      `data: ${JSON.stringify({ directory: cwd, payload: { id: `evt_${++eventId}`, type: 'server.connected', properties: {} } })}\n\n`,
    )
    return
  }
  if (path === '/global/health' && config.mode === 'park-health') return
  let value
  if (path === '/global/health') value = { healthy: true, version: '1.18.26' }
  else if (path === '/session' || path === '/session/ses_fixture')
    value = session
  else if (path === '/path') value = { directory: cwd }
  else if (path === '/provider') value = wire.provider
  else if (path === '/agent') value = wire.agents
  else if (path === '/command') value = wire.commands
  else if (path === '/config' || path === '/session/status') value = {}
  else if (path === '/session/ses_fixture/message') value = history
  else if (path.endsWith('/prompt_async')) {
    const model = body.model ?? {
      providerID: session.model.providerID,
      modelID: session.model.id,
    }
    session.model = {
      providerID: model.providerID,
      id: model.modelID,
      variant: body.variant ?? 'default',
    }
    session.time.updated = Date.now()
    for (const stream of streams)
      stream.write(
        `data: ${JSON.stringify({ directory: cwd, payload: { id: `evt_${++eventId}`, type: 'session.updated', properties: { sessionID: session.id, info: session } } })}\n\n`,
      )
    if (config.mode === 'automatic') {
      const user = {
        info: {
          id: body.messageID,
          sessionID: 'ses_fixture',
          role: 'user',
          time: { created: 1 },
          model,
        },
        parts: [],
      }
      const auto = {
        info: {
          id: 'msg_auto',
          sessionID: 'ses_fixture',
          role: 'user',
          time: { created: 2 },
        },
        parts: [
          {
            id: 'prt_compact',
            sessionID: 'ses_fixture',
            messageID: 'msg_auto',
            type: 'compaction',
            auto: true,
            tail_start_id: body.messageID,
          },
        ],
      }
      const final = {
        info: {
          id: 'msg_final',
          parentID: 'msg_auto',
          sessionID: 'ses_fixture',
          role: 'assistant',
          time: { created: 3, completed: 4 },
          finish: 'stop',
        },
        parts: [
          {
            id: 'prt_final',
            sessionID: 'ses_fixture',
            messageID: 'msg_final',
            type: 'text',
            text: 'automatic result',
          },
        ],
      }
      history.push(user, auto, final)
      for (const stream of streams) {
        stream.write(
          `data: ${JSON.stringify({ directory: cwd, payload: { id: `evt_${++eventId}`, type: 'message.updated', properties: { sessionID: 'ses_fixture', info: user.info } } })}\n\n`,
        )
        stream.write(
          `data: ${JSON.stringify({ directory: cwd, payload: { id: `evt_${++eventId}`, type: 'session.idle', properties: { sessionID: 'ses_fixture' } } })}\n\n`,
        )
      }
    }
    res.writeHead(204).end()
    return
  } else if (path.endsWith('/abort')) value = true
  else if (
    [
      '/question',
      '/permission',
      '/session/ses_fixture/message',
      '/session/ses_fixture/children',
    ].includes(path)
  )
    value = []
  else {
    res.writeHead(404).end('{}')
    return
  }
  res
    .writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify(value))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
report.origin = origin
save()
const line = `opencode server listening on ${config.mode === 'bad-origin' ? 'http://192.0.2.1:1234' : origin}\n`
for (const char of line)
  await new Promise((resolve) => process.stdout.write(char, resolve))
if (config.mode === 'conflicting-origin')
  process.stdout.write('opencode server listening on http://127.0.0.1:1234\n')
const heartbeat = setInterval(() => {
  for (const stream of streams) stream.write(': heartbeat\n\n')
}, 1000)
process.once('SIGTERM', () => {
  clearInterval(heartbeat)
  for (const stream of streams) stream.end()
  server.closeAllConnections()
  server.close(() => process.exit(0))
})
