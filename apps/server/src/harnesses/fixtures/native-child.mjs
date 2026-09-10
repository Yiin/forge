import { closeSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const [mode, payload] = process.argv.slice(2)
const encode = (value) => {
  if (mode === 'rpc-unversioned') {
    const { jsonrpc: _version, ...envelope } = value
    return JSON.stringify(envelope)
  }
  return JSON.stringify(value)
}
const send = (value) => process.stdout.write(`${encode(value)}\n`)
const keepAlive = () => setInterval(() => {}, 1000)
if (mode === 'bytes') {
  keepAlive()
  const { chunks, end = true } = JSON.parse(payload)
  for (const chunk of chunks) {
    process.stdout.write(Buffer.from(chunk, 'base64'))
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (end) process.stdout.end()
} else if (mode === 'noisy') {
  setInterval(() => send({ type: 'noise' }), 5)
} else if (mode === 'epipe') {
  closeSync(0)
  send({ type: 'ready' })
  keepAlive()
} else if (mode === 'ignore-term') {
  process.on('SIGTERM', () => {})
  send({ type: 'ready', pid: process.pid })
  keepAlive()
} else if (mode === 'tree') {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    process.on('SIGTERM', () => {});
    process.send({ pid: process.pid });
    setInterval(() => {}, 1000);
  `,
    ],
    { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] },
  )
  child.once('message', ({ pid }) =>
    send({ type: 'ready', pid: process.pid, descendant: pid }),
  )
  process.stdin.once('data', () => process.exit(0))
  keepAlive()
} else if (mode === 'stderr') {
  keepAlive()
  for (const part of JSON.parse(payload)) {
    process.stderr.write(Buffer.from(part, 'base64'))
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  process.stderr.end()
  send({ type: 'ready' })
} else {
  keepAlive()
  const reader = createInterface({ input: process.stdin })
  let outer
  const dismissalReplies = []
  let dismissalNotifications = 0
  reader.on('line', (line) => {
    const message = JSON.parse(line)
    if (mode === 'rpc-unversioned' && Object.hasOwn(message, 'jsonrpc'))
      throw new Error('Expected an unversioned envelope')
    if (!message.method) {
      if (message.id === 7 || message.id === 8)
        dismissalReplies.push({
          id: message.id,
          ...('error' in message
            ? { error: message.error }
            : { result: message.result }),
        })
      if (outer && message.id === outer.id) {
        send({
          jsonrpc: '2.0',
          id: outer.id,
          ...('error' in message
            ? { error: message.error }
            : { result: message.result }),
        })
        outer = undefined
      }
      return
    }
    if (message.method === 'pending') return
    if (message.method === 'dismissal/start') {
      send({ jsonrpc: '2.0', id: 7, method: 'dismissal/approval', params: {} })
      send({
        jsonrpc: '2.0',
        method: 'serverRequest/resolved',
        params: { requestId: 7, threadId: 'fixture-thread' },
      })
      send({ jsonrpc: '2.0', id: 7, method: 'dismissal/replacement' })
      send({ jsonrpc: '2.0', id: 8, method: 'dismissal/unrelated' })
      send({ jsonrpc: '2.0', method: 'dismissal/tick' })
      send({ jsonrpc: '2.0', id: message.id, result: true })
    } else if (message.method === 'dismissal/client-note') {
      dismissalNotifications++
    } else if (message.method === 'dismissal/report') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          replies: dismissalReplies,
          notifications: dismissalNotifications,
        },
      })
    } else if (message.method === 'outer') {
      outer = message
      send({ jsonrpc: '2.0', id: message.id, method: 'approval', params: {} })
    } else if (message.method === 'nested') {
      process.stdout.write(
        Array.from({ length: 300 }, (_, index) =>
          encode({ jsonrpc: '2.0', method: 'tick', params: { index } }),
        ).join('\n') +
          '\n' +
          encode({
            jsonrpc: '2.0',
            id: message.id,
            result: 'nested result',
          }) +
          '\n',
      )
    } else if (message.method === 'resume') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32001,
          message: `Resume rejected: ${process.env.FORGE_TEST_SECRET}`,
          data: {
            token: process.env.FORGE_TEST_SECRET,
            privatePayload: 'never expose this payload',
          },
        },
      })
    } else if (message.method === 'exit') {
      process.stdout.write(
        encode({
          jsonrpc: '2.0',
          id: message.id,
          result: 'final reply',
        }),
        () => process.exit(0),
      )
    } else if (message.method === 'large-exit') {
      process.stdout.write(
        encode({
          jsonrpc: '2.0',
          id: message.id,
          result: 'x'.repeat(500_000),
        }),
        () => process.exit(0),
      )
    } else if (message.method === 'env') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          cwd: process.cwd(),
          home: process.env.CODEX_HOME,
          inherited: process.env.FORGE_TEST_INHERITED,
          pid: process.pid,
        },
      })
    } else if (message.id !== undefined) {
      send({ jsonrpc: '2.0', id: message.id, result: message.params ?? null })
    }
  })
}
