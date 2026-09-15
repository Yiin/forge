import { readFile, readlink, readdir, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'

// Only Node built-ins run before container and environment authority is granted.
if (process.argv[2] === '--detached-probe') {
  const directory = process.argv[3]
  if (!/^\/tmp\/forge-cursor-container-[^/]+$/.test(directory))
    throw new Error('cursor_probe_path')
  process.on('SIGTERM', () => {})
  const timer = setInterval(() => {
    void appendFile(join(directory, 'heartbeat'), '.')
  }, 30)
  timer.ref()
} else if (process.argv[2] === '--managed-probe') {
  const [generation, nonce, directory] = process.argv.slice(3)
  if (!/^\/tmp\/forge-cursor-container-[^/]+$/.test(directory))
    throw new Error('cursor_probe_path')
  let bytes = 0,
    granted = false,
    sequence = 0
  process.stdin.on('data', (chunk) => {
    bytes += chunk.length
    if (bytes > 65536) process.exitCode = 1
  })
  const input = createInterface({ input: process.stdin })
  setInterval(() => {}, 1000)
  process.stdout.write(
    JSON.stringify({
      v: 1,
      generation,
      type: 'bootstrap_wait',
      nonce,
      pid: process.pid,
      seq: ++sequence,
    }) + '\n',
  )
  for await (const line of input) {
    const frame = JSON.parse(line)
    if (frame.type === 'container_bound' && !granted && frame.nonce === nonce) {
      granted = true
      const child = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), '--detached-probe', directory],
        { detached: true, stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } },
      )
      child.unref()
      process.stdout.write(
        JSON.stringify({
          v: 1,
          generation,
          type: 'ready',
          requestId: frame.requestId,
          pid: process.pid,
          writerPid: child.pid,
          seq: ++sequence,
        }) + '\n',
      )
    } else if (frame.type === 'close')
      process.stdout.write(
        JSON.stringify({
          v: 1,
          generation,
          type: 'closed',
          requestId: frame.requestId,
          seq: ++sequence,
        }) + '\n',
      )
  }
} else if (process.argv[2] === '--runtime-probe') {
  const [outside, root, scope = 'full'] = process.argv.slice(3)
  if (!['full', 'store-contract'].includes(scope))
    throw new Error('cursor_probe_scope')
  const namespace = await readlink('/proc/self/ns/net')
  const interfaces = (await readdir('/sys/class/net')).sort()
  const routes = await readFile('/proc/net/route', 'utf8')
  if (
    !outside ||
    namespace === outside ||
    interfaces.join(',') !== 'lo' ||
    routes.trim().split('\n').length !== 1 ||
    !root?.startsWith('/probe-data/')
  )
    throw new Error('cursor_probe_isolation_failed')
  const requests: Array<{ method: string; path: string }> = []
  let unexpected = false
  const fixture = createServer((request, response) => {
    if (requests.length >= 8) {
      unexpected = true
      response.destroy()
      return
    }
    const path = request.url?.split('?')[0] ?? ''
    requests.push({ method: request.method ?? '', path })
    if (path !== '/auth/exchange_user_api_key' || request.method !== 'POST')
      unexpected = true
    response.writeHead(403, { 'content-type': 'application/json' })
    response.end('{"error":"synthetic rejection"}')
  })
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve))
  const address = fixture.address()
  if (!address || typeof address === 'string')
    throw new Error('cursor_probe_fixture_failed')
  for (const key of Object.keys(process.env)) delete process.env[key]
  process.env.HOME = join(root, 'home')
  process.env.CURSOR_CONFIG_DIR = join(root, 'home', '.cursor')
  process.env.CURSOR_DATA_DIR = join(root, 'native-data')
  process.env.CURSOR_BACKEND_URL = `http://127.0.0.1:${address.port}`
  process.env.PATH = '/usr/bin:/bin'
  process.env.LANG = 'C.UTF-8'
  for (const directory of [
    process.env.HOME,
    process.env.CURSOR_CONFIG_DIR,
    process.env.CURSOR_DATA_DIR,
  ])
    await mkdir(directory, { recursive: true, mode: 0o700 })
  let result: unknown
  try {
    const sdk = await import('@cursor/sdk')
    const { probe, storeContract } = await import(
      new URL('./probe.mjs', import.meta.url).href
    )
    result =
      scope === 'store-contract'
        ? await storeContract(sdk, root)
        : await probe(sdk, root, fileURLToPath(new URL('.', import.meta.url)))
  } catch (error) {
    result = {
      passed: false,
      error:
        error instanceof Error
          ? error.message.slice(0, 4096)
          : 'cursor_probe_failed',
    }
  } finally {
    await new Promise<void>((resolve) => fixture.close(() => resolve()))
  }
  const output = { scope, namespace, interfaces, requests, unexpected, result }
  process.stdout.write(JSON.stringify(output) + '\n')
  process.exitCode =
    !unexpected &&
    (result as { passed?: boolean }).passed &&
    (scope === 'store-contract'
      ? requests.length === 0
      : requests.some((row) => row.path === '/auth/exchange_user_api_key'))
      ? 0
      : 1
} else {
  const { bootstrap } = await import(
    new URL('./sidecar-runtime.mjs', import.meta.url).href
  )
  await bootstrap()
}
