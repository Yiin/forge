import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { runE2e, startDevServer } from './run-e2e.mjs'
import { devServerOrigin, devServerPort } from '../helpers/devServer.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

it('keeps concurrent Vite listeners distinct while an unrelated assigned port stays owned', async () => {
  const unrelated = createServer((_request, response) =>
    response.end('original'),
  )
  await new Promise<void>((resolve) =>
    unrelated.listen(0, '127.0.0.1', resolve),
  )
  const originalPort = (unrelated.address() as { port: number }).port
  vi.stubEnv('FORGE_E2E_PORT', String(originalPort))
  const servers: Awaited<ReturnType<typeof startDevServer>>[] = []
  const sockets: Socket[] = []
  const socketClosures: Promise<unknown>[] = []
  const socketErrors: string[] = []
  try {
    const results = await Promise.allSettled([
      startDevServer(),
      startDevServer(),
    ])
    for (const result of results)
      if (result.status === 'fulfilled') servers.push(result.value)
    expect(results.filter((result) => result.status === 'rejected')).toEqual([])
    expect(
      new Set([originalPort, ...servers.map((server) => server.port)]).size,
    ).toBe(3)
    for (const server of servers)
      expect((await fetch(`http://127.0.0.1:${server.port}`)).status).toBe(200)
    expect(await (await fetch(`http://127.0.0.1:${originalPort}`)).text()).toBe(
      'original',
    )
    for (const server of servers) {
      const socket = createConnection({ host: '127.0.0.1', port: server.port })
      sockets.push(socket)
      socket.on('error', (error: NodeJS.ErrnoException) =>
        socketErrors.push(error.code ?? 'unknown'),
      )
      socketClosures.push(
        new Promise((resolve) => socket.once('close', resolve)),
      )
      await once(socket, 'connect')
      socket.write('GET / HTTP/1.1\r\n')
    }
  } finally {
    const cleanup = await Promise.allSettled([
      ...servers.map((server) => server.close()),
      new Promise<void>((resolve, reject) =>
        unrelated.close((error) => (error ? reject(error) : resolve())),
      ),
    ])
    await Promise.all(socketClosures)
    expect(cleanup.filter((result) => result.status === 'rejected')).toEqual([])
    expect(sockets).toHaveLength(2)
    expect(sockets.every((socket) => socket.destroyed)).toBe(true)
    expect(socketErrors.every((code) => code === 'ECONNRESET')).toBe(true)
  }
  for (const server of servers)
    await expect(fetch(`http://127.0.0.1:${server.port}`)).rejects.toThrow()
}, 30000)

function fixture() {
  const signals = new EventEmitter()
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
  const close = vi.fn(async () => {})
  const startServer = vi.fn(async () => ({ port: 32123, close }))
  const spawnChild = vi.fn(() => child)
  const options = { startServer, spawnChild, signalSource: signals }
  return { signals, child, close, startServer, spawnChild, options }
}

it('passes CLI arguments and captured port, preserves exit status, and waits for original child close', async () => {
  const f = fixture()
  vi.stubEnv('FORGE_E2E_PORT', '5481')
  const result = runE2e(['--project=phone', '--grep', 'two words'], f.options)
  await vi.waitFor(() => expect(f.spawnChild).toHaveBeenCalledOnce())
  const [command, args, options] = f.spawnChild.mock.calls[0] as any
  expect(command).toBe(process.execPath)
  expect(args.slice(-3)).toEqual(['--project=phone', '--grep', 'two words'])
  expect(options.env.FORGE_E2E_PORT).toBe('32123')
  f.child.emit('exit', 7, null)
  expect(f.close).not.toHaveBeenCalled()
  f.child.emit('close', 7, null)
  expect(await result).toBe(7)
  expect(f.close).toHaveBeenCalledOnce()
  expect(f.signals.listenerCount('SIGTERM')).toBe(0)
})

it.each(['SIGINT', 'SIGTERM'] as const)(
  'forwards %s only to its original child and joins cleanup',
  async (signal) => {
    const f = fixture()
    const result = runE2e([], f.options)
    await vi.waitFor(() => expect(f.spawnChild).toHaveBeenCalledOnce())
    f.signals.emit(signal)
    f.signals.emit(signal)
    expect(f.child.kill.mock.calls).toEqual([[signal]])
    expect(f.close).not.toHaveBeenCalled()
    f.child.emit('close', null, signal)
    expect(await result).toBe(signal === 'SIGINT' ? 130 : 143)
    expect(f.close).toHaveBeenCalledOnce()
    expect(f.signals.listenerCount(signal)).toBe(0)
  },
)

it('closes a server which finishes startup after interruption without spawning tests', async () => {
  const f = fixture()
  let release!: (value: any) => void
  f.startServer.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const result = runE2e([], f.options)
  f.signals.emit('SIGTERM')
  release({ port: 32123, close: f.close })
  expect(await result).toBe(143)
  expect(f.spawnChild).not.toHaveBeenCalled()
  expect(f.close).toHaveBeenCalledOnce()
})

it('closes Vite after failed child startup without hiding the original error', async () => {
  const f = fixture()
  const error = Error('synthetic spawn failure')
  const result = runE2e([], f.options)
  const rejected = expect(result).rejects.toBe(error)
  await vi.waitFor(() => expect(f.spawnChild).toHaveBeenCalledOnce())
  f.child.emit('error', error)
  expect(f.close).not.toHaveBeenCalled()
  f.child.emit('close', -2, null)
  await rejected
  expect(f.close).toHaveBeenCalledOnce()
})

it('cleans signal handlers when Vite startup rejects', async () => {
  const f = fixture()
  f.startServer.mockRejectedValue(Error('synthetic Vite failure'))
  await expect(runE2e([], f.options)).rejects.toThrow('synthetic Vite failure')
  expect(f.spawnChild).not.toHaveBeenCalled()
  expect(f.signals.listenerCount('SIGINT')).toBe(0)
  expect(f.signals.listenerCount('SIGTERM')).toBe(0)
})

it.each(['', '0', '-1', '65536', '5481suffix'])(
  'rejects missing or invalid launcher port %s',
  (value) => {
    vi.stubEnv('FORGE_E2E_PORT', value)
    expect(devServerPort).toThrow('bun run e2e')
  },
)

it('shares the exact captured origin with the Forge helper', () => {
  vi.stubEnv('FORGE_E2E_PORT', '32123')
  expect(devServerOrigin()).toBe('http://127.0.0.1:32123')
})

it('closes the original server when spawning throws synchronously', async () => {
  const f = fixture()
  const failure = Error('synthetic spawn throw')
  f.spawnChild.mockImplementation(() => {
    throw failure
  })
  await expect(runE2e([], f.options)).rejects.toBe(failure)
  expect(f.close).toHaveBeenCalledOnce()
  expect(f.signals.listenerCount('SIGINT')).toBe(0)
})

it('retains both startup and original cleanup failures', async () => {
  const f = fixture()
  const startup = Error('synthetic spawn throw')
  const cleanup = Error('synthetic close refusal')
  f.spawnChild.mockImplementation(() => {
    throw startup
  })
  f.close.mockRejectedValue(cleanup)
  await expect(runE2e([], f.options)).rejects.toMatchObject({
    errors: [startup, cleanup],
  })
  expect(f.close).toHaveBeenCalledOnce()
  expect(f.signals.listenerCount('SIGTERM')).toBe(0)
})

it('retains a held graceful shutdown without killing its original CLI', async () => {
  vi.useFakeTimers()
  const f = fixture()
  let settled = false
  const result = runE2e([], f.options).finally(() => {
    settled = true
  })
  await vi.advanceTimersByTimeAsync(0)
  f.signals.emit('SIGTERM')
  await vi.advanceTimersByTimeAsync(60000)
  expect(f.child.kill.mock.calls).toEqual([['SIGTERM']])
  expect(f.close).not.toHaveBeenCalled()
  expect(settled).toBe(false)
  f.child.emit('close', null, 'SIGTERM')
  expect(await result).toBe(143)
  expect(f.close).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('returns the child exit code when server cleanup hangs', async () => {
  const f = fixture()
  f.close.mockImplementation(() => new Promise(() => {}))
  const result = runE2e([], { ...f.options, cleanupTimeoutMs: 50 })
  await vi.waitFor(() => expect(f.spawnChild).toHaveBeenCalledOnce())
  f.child.emit('close', 1, null)
  expect(await result).toBe(1)
  expect(f.close).toHaveBeenCalledOnce()
  expect(f.signals.listenerCount('SIGINT')).toBe(0)
  expect(f.signals.listenerCount('SIGTERM')).toBe(0)
})
