import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { startServer } from '../../apps/server/src/index.ts'

if (Number(process.versions.node.split('.')[0]) < 24)
  throw Error('Request acceptance requires the production Node server')
const server = startServer(0)
const sockets = new Set()
const socketClosures = []
const traffic = []
server.on('request', (request, response) => {
  response.once('finish', () =>
    traffic.push({
      method: request.method,
      url: request.url,
      origin: request.headers.origin,
      site: request.headers['sec-fetch-site'],
      status: response.statusCode,
    }),
  )
})
server.on('connection', (socket) => {
  sockets.add(socket)
  socketClosures.push(new Promise((resolve) => socket.once('close', resolve)))
  socket.once('close', () => sockets.delete(socket))
})
if (!server.listening) await once(server, 'listening')
const db = new DatabaseSync(join(process.env.FORGE_DATA_DIR, 'forge.db'))
const project = process.env.FORGE_TEST_PROJECT
db.prepare('INSERT INTO projects(id,name,path,created_at) VALUES(?,?,?,?)').run(
  'boundary-project',
  'Boundary fixture',
  project,
  Date.now(),
)
db.prepare(
  `INSERT INTO sessions(id,project_id,harness,title,cwd,kind,status,auto_resume,created_at,last_activity_at)
 VALUES(?,?,?,?,?,'chat','idle',0,?,?)`,
).run(
  'boundary-session',
  'boundary-project',
  'boundary-fake',
  'Synthetic session',
  project,
  Date.now(),
  Date.now(),
)
db.prepare(
  `INSERT INTO messages(session_id,turn_id,item_id,role,type,content,created_at)
 VALUES(?,?,?,?,?,?,?)`,
).run(
  'boundary-session',
  'boundary-turn',
  'boundary-item',
  'agent',
  'text_delta',
  JSON.stringify({ type: 'text_delta', text: 'BOUNDARY_SYNTHETIC_TRANSCRIPT' }),
  Date.now(),
)
const snapshot = () => ({
  projects: db.prepare('SELECT count(*) AS n FROM projects').get().n,
  messages: db.prepare('SELECT count(*) AS n FROM messages').get().n,
  sessions: db.prepare('SELECT id,status FROM sessions ORDER BY id').all(),
  attachments: db
    .prepare('SELECT status,size_bytes,mime,rel_path FROM attachments')
    .all()
    .map((row) => ({
      status: row.status,
      size_bytes: row.size_bytes,
      mime: row.mime,
      bytes: row.rel_path
        ? readFileSync(join(process.env.FORGE_DATA_DIR, row.rel_path)).toString(
            'base64',
          )
        : null,
    })),
})
process.send({
  type: 'ready',
  port: server.address().port,
  pid: process.pid,
  snapshot: snapshot(),
})
process.on('message', async (message) => {
  if (message.type === 'traffic') process.send({ type: 'traffic', traffic })
  if (message.type === 'snapshot')
    process.send({ type: 'snapshot', snapshot: snapshot() })
  if (message.type === 'stop') {
    if (process.env.FORGE_TEST_STOP_FAULT === 'disconnect') {
      process.disconnect()
      return
    }
    if (process.env.FORGE_TEST_STOP_FAULT === 'refuse') {
      process.send({
        type: 'cleanup_failed',
        message: 'Injected original cleanup refusal',
      })
      return
    }
    try {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      await Promise.all(socketClosures)
      const stopped = db
        .prepare('SELECT stopped_at FROM server_boots WHERE id=1')
        .get().stopped_at
      db.close()
      process.send({ type: 'stopped', sockets: sockets.size, stopped }, () =>
        process.disconnect(),
      )
    } catch (error) {
      process.send({ type: 'cleanup_failed', message: String(error) })
    }
  }
})
