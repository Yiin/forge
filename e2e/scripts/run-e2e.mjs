import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { createRequire } from 'node:module'
import { constants } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const webRequire = createRequire(
  new URL('../../apps/web/package.json', import.meta.url),
)
const e2eRequire = createRequire(new URL('../package.json', import.meta.url))

export async function startDevServer() {
  const { createServer } = await import(
    pathToFileURL(webRequire.resolve('vite')).href
  )
  const http = createHttpServer()
  let vite
  const close = async () => {
    const results = await Promise.allSettled([
      vite?.close(),
      new Promise((resolve, reject) => {
        http.close((error) =>
          error && error.code !== 'ERR_SERVER_NOT_RUNNING'
            ? reject(error)
            : resolve(),
        )
        http.closeAllConnections()
      }),
    ])
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'E2E server cleanup failed',
      )
  }
  try {
    vite = await createServer({
      root: fileURLToPath(new URL('../../apps/web', import.meta.url)),
      server: { middlewareMode: true, hmr: { server: http } },
    })
    http.on('request', vite.middlewares)
    await new Promise((resolve, reject) => {
      http.once('error', reject)
      http.listen(0, '127.0.0.1', () => {
        http.off('error', reject)
        resolve()
      })
    })
    const address = http.address()
    if (!address || typeof address === 'string' || !address.port)
      throw Error('Vite did not bind an E2E port')
    return { port: address.port, close }
  } catch (error) {
    await close().catch((cleanup) => {
      throw new AggregateError(
        [error, cleanup],
        'E2E startup and cleanup failed',
      )
    })
    throw error
  }
}

export async function runE2e(
  args,
  {
    startServer = startDevServer,
    spawnChild = spawn,
    signalSource = process,
    cleanupTimeoutMs = 5000,
  } = {},
) {
  let server, child, requestedSignal, primaryFailure
  let childClosed = false
  const stop = (signal) => {
    if (requestedSignal) return
    requestedSignal = signal
    if (child && !childClosed) {
      child.kill(signal)
    }
  }
  const interrupt = () => stop('SIGINT')
  const terminate = () => stop('SIGTERM')
  signalSource.on('SIGINT', interrupt)
  signalSource.on('SIGTERM', terminate)
  try {
    server = await startServer()
    if (requestedSignal) return 128 + constants.signals[requestedSignal]
    child = spawnChild(
      process.execPath,
      [
        e2eRequire.resolve('@playwright/test/cli'),
        'test',
        '-c',
        'e2e/playwright.config.ts',
        ...args,
      ],
      {
        cwd: root,
        env: { ...process.env, FORGE_E2E_PORT: String(server.port) },
        stdio: 'inherit',
      },
    )
    let failure
    const result = await new Promise((resolve) => {
      child.once('error', (error) => {
        failure = error
      })
      child.once('close', (code, signal) => {
        childClosed = true
        resolve({ code, signal })
      })
    })
    if (failure) throw failure
    return requestedSignal
      ? 128 + constants.signals[requestedSignal]
      : (result.code ?? 128 + (constants.signals[result.signal] ?? 1))
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    try {
      const cleanup = server?.close().catch((error) => {
        if (primaryFailure)
          throw new AggregateError(
            [primaryFailure, error],
            'E2E run and cleanup failed',
          )
        throw error
      })
      // A hung server close must not strand the child exit code: bound the
      // wait, otherwise the runE2e promise never settles and the process
      // exits 0 on an empty event loop.
      let timer
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
          console.error('E2E server cleanup timed out')
          resolve()
        }, cleanupTimeoutMs)
      })
      try {
        await Promise.race([cleanup, timeout])
      } finally {
        clearTimeout(timer)
      }
    } finally {
      signalSource.off('SIGINT', interrupt)
      signalSource.off('SIGTERM', terminate)
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runE2e(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(error)
      process.exitCode = 1
    },
  )
}
