import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect } from 'node:net'

type Snapshot = {
  projects: number
  messages: number
  sessions: Array<{ id: string; status: string }>
  attachments: Array<{
    status: string
    size_bytes: number
    mime: string
    bytes: string | null
  }>
}
type Traffic = {
  method: string
  url: string
  origin?: string
  site?: string
  status: number
}
export async function bounded<T>(
  work: Promise<T>,
  message: string,
  milliseconds = 15000,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(message)), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function productionRequestServer(
  access?: {
    origin: string
    host: string
  },
  stopFault?: 'disconnect' | 'refuse',
) {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const directory = await mkdtemp(join(tmpdir(), 'forge-production-boundary-'))
  const home = join(directory, 'home')
  const project = join(directory, 'project')
  await Promise.all([mkdir(home), mkdir(project)])
  const config = join(directory, 'forge.toml')
  await writeFile(
    config,
    (access
      ? `[terminalAccess]\nmode="explicit"\nallowedOrigins=[${JSON.stringify(access.origin)}]\nallowedHostAuthorities=[${JSON.stringify(access.host)}]\n`
      : '') +
      '[harness.boundary-fake]\nname="Boundary fake"\nenv={}\nprotocol="pty"\ncommand="/bin/false"\nargs=[]\n',
  )
  const child = spawn(
    'node',
    [
      '--import',
      resolve(root, 'e2e/helpers/production-request-loader.mjs'),
      resolve(root, 'e2e/helpers/production-request-server.mjs'),
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_DATA_HOME: join(home, '.local/share'),
        NODE_ENV: 'test',
        FORGE_CONFIG: config,
        FORGE_DATA_DIR: directory,
        FORGE_TEST_PROJECT: project,
        ...(stopFault ? { FORGE_TEST_STOP_FAULT: stopFault } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  )
  let log = ''
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (chunk) => {
      log = (log + String(chunk)).slice(-32000)
    })
  let physicallyClosed = false
  const exit = new Promise<{ code: number | null; signal: string | null }>(
    (resolveExit) =>
      child.once('close', (code, signal) => {
        physicallyClosed = true
        resolveExit({ code, signal })
      }),
  )
  const fallback = async (primary: unknown): Promise<never> => {
    const errors = [primary]
    let result: Awaited<typeof exit> | undefined
    try {
      if (!physicallyClosed) child.kill('SIGTERM')
      try {
        result = await bounded(
          exit,
          'Original production SIGTERM cleanup timed out',
          8000,
        )
      } catch (error) {
        errors.push(error)
        if (!physicallyClosed) child.kill('SIGKILL')
        result = await bounded(
          exit,
          'Original production SIGKILL cleanup timed out',
          3000,
        )
      }
    } catch (error) {
      errors.push(error)
    }
    await writeFile(join(directory, 'failure.log'), log).catch((error) =>
      errors.push(error),
    )
    throw Object.assign(
      new AggregateError(errors, 'Production cleanup required fallback'),
      {
        cleanup: {
          pid: child.pid,
          graceful: false,
          physicallyClosed,
          ...result,
        },
      },
    )
  }
  const wait = <T>(type: string, send?: string) =>
    new Promise<T>((resolveMessage, reject) => {
      let settled = false
      const timer = setTimeout(
        () => finish(Error(`Production ${type} timed out: ${log}`)),
        15000,
      )
      const message = (value: unknown) => {
        const envelope = value as { type?: string; message?: string }
        if (envelope.type === type) finish(undefined, value as T)
        else if (envelope.type === 'cleanup_failed')
          finish(Error(envelope.message))
      }
      const gone = () =>
        finish(
          Error(`Production disconnected or exited before ${type}: ${log}`),
        )
      const finish = (error?: Error, value?: T) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.off('message', message)
        child.off('close', gone)
        child.off('disconnect', gone)
        child.off('error', finish)
        if (error) reject(error)
        else resolveMessage(value!)
      }
      child.on('message', message)
      child.once('close', gone)
      child.once('disconnect', gone)
      child.once('error', finish)
      if (send)
        child.send({ type: send }, (error) => {
          if (error) finish(error)
        })
    })
  let ready: { port: number; pid: number; snapshot: Snapshot }
  try {
    ready = await wait('ready')
  } catch (error) {
    return fallback(error)
  }
  const baseUrl = `http://127.0.0.1:${ready.port}`
  return {
    baseUrl,
    project,
    directory,
    pid: ready.pid,
    initial: ready.snapshot,
    async traffic() {
      return (await wait<{ traffic: Traffic[] }>('traffic', 'traffic')).traffic
    },
    async snapshot() {
      return (await wait<{ snapshot: Snapshot }>('snapshot', 'snapshot'))
        .snapshot
    },
    async stop() {
      try {
        if (!child.connected) throw Error(`Production child exited: ${log}`)
        const stopped = wait<{ sockets: number; stopped: number }>(
          'stopped',
          'stop',
        )
        const receipt = await stopped
        const result = await bounded(exit, 'Production process did not exit')
        if (result.code !== 0 || receipt.sockets !== 0 || !receipt.stopped)
          throw Error(
            `Production cleanup failed: ${JSON.stringify({ receipt, result })}`,
          )
        const closed = await new Promise<boolean>(
          (resolveClosed, rejectClosed) => {
            const socket = connect(ready.port, '127.0.0.1')
            let refused = false
            const timer = setTimeout(() => {
              socket.destroy()
              rejectClosed(Error('Listener closure check timed out'))
            }, 3000)
            socket.once('connect', () => {
              socket.destroy()
            })
            socket.once('error', (error: NodeJS.ErrnoException) => {
              refused = error.code === 'ECONNREFUSED'
            })
            socket.once('close', () => {
              clearTimeout(timer)
              resolveClosed(refused)
            })
          },
        )
        if (!closed) throw Error('Original production listener remains open')
        await rm(directory, { recursive: true, force: true })
        return { ...receipt, ...result, pid: ready.pid, listenerClosed: closed }
      } catch (error) {
        return fallback(error)
      }
    },
  }
}
