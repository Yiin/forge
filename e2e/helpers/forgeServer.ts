import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { devServerOrigin } from './devServer.js'

export type ForgeServer = {
  baseUrl: string
  dataDir: string
  stop: () => Promise<void>
}
export type LaunchOptions = {
  env?: Record<string, string>
  dataDir?: string
  fakeAgentEnv?: Record<string, string>
}

type ForgeRoutePage = {
  route(
    pattern: string,
    handler: (route: {
      request(): {
        url(): string
        method(): string
        headers(): Record<string, string>
        postDataBuffer(): Buffer | null
      }
      fulfill(options: {
        status: number
        headers: Record<string, string>
        body: Buffer
      }): Promise<void>
    }) => Promise<void>,
  ): Promise<void>
}

/**
 * Point the app's `/api` calls at an isolated Forge server.
 *
 * Headers are forwarded, not rebuilt. The real server rejects a draft
 * promotion that arrives without its `Idempotency-Key`, and only the app knows
 * which key it sent. The origin travels too, and the server is configured to
 * accept the dev server it comes from.
 */
export async function proxyForgeApi(
  page: ForgeRoutePage,
  forge: { baseUrl: string },
): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const requestUrl = new URL(route.request().url())
    const headers = { ...route.request().headers() }
    // The response is re-served verbatim, so never invite a compressed one.
    for (const key of ['host', 'accept-encoding', 'connection', 'referer'])
      delete headers[key]
    const response = await fetch(
      `${forge.baseUrl}${requestUrl.pathname}${requestUrl.search}`,
      {
        method: route.request().method(),
        headers,
        body: route.request().postDataBuffer() ?? undefined,
      },
    )
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    })
  })
}

export async function stopProxiedForge(
  page: {
    unrouteAll(options: { behavior: 'wait' }): Promise<void>
  },
  forge: {
    stop(): Promise<void>
  },
): Promise<void> {
  let routeFailure: { error: unknown } | undefined
  let stopFailure: { error: unknown } | undefined
  try {
    try {
      await page.unrouteAll({ behavior: 'wait' })
    } catch (error) {
      routeFailure = { error }
    }
  } finally {
    try {
      await forge.stop()
    } catch (error) {
      stopFailure = { error }
    }
  }
  if (routeFailure && stopFailure)
    throw new AggregateError(
      [routeFailure.error, stopFailure.error],
      'Failed to clean up proxied Forge server',
    )
  if (routeFailure) throw routeFailure.error
  if (stopFailure) throw stopFailure.error
}

export async function launchForge(
  options: LaunchOptions = {},
): Promise<ForgeServer> {
  const dataDir = resolve(
    options.dataDir ?? (await mkdtemp(`${tmpdir()}/forge-e2e-`)),
  )
  const tmpRoot = resolve(tmpdir())
  if (dataDir !== tmpRoot && !dataDir.startsWith(`${tmpRoot}/`))
    throw new Error('e2e data directory must be under tmpdir')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const fakeAgent = resolve(root, 'apps/server/test/fixtures/acp-mock-agent.ts')
  const fakeAgentEnv = { ...options.fakeAgentEnv }
  const repeat = options.env?.FORGE_E2E_REPLY_REPEAT
  if (repeat) {
    fakeAgentEnv.FORGE_MOCK_REPLY_REPEAT = repeat
    fakeAgentEnv.FORGE_MOCK_PROMPT_RESPONSE_TEXT = 'first second third'
  }
  const tomlEnv = Object.entries(fakeAgentEnv)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join('\n')
  // The browser is served by the dev server and calls Forge on another port,
  // so the request guard has to be told about both. That needs the port up
  // front, which rules out letting the kernel pick one at listen time.
  const port = await reservePort()
  const origins = [
    devServerOrigin(),
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]
  await writeFile(
    resolve(dataDir, 'forge.toml'),
    [
      `dataDir = ${JSON.stringify(dataDir)}`,
      '[terminalAccess]',
      'mode = "explicit"',
      `allowedOrigins = ${JSON.stringify(origins)}`,
      `allowedHostAuthorities = ${JSON.stringify([`127.0.0.1:${port}`, `localhost:${port}`])}`,
      '[harness.mock]',
      'name = "E2E native protocol fixture"',
      'protocol = "acp"',
      'command = "bun"',
      `args = [${JSON.stringify(fakeAgent)}]`,
      'adapterKind = "acp"',
      'enabled = true',
      // `env` is required by the harness schema, so the table is never optional.
      // Omitting it when there are no knobs stops the server from booting.
      '[harness.mock.env]',
      ...(tomlEnv ? [tomlEnv] : []),
      '',
    ].join('\n'),
  )
  spawnSync('sqlite3', [
    resolve(dataDir, 'forge.db'),
    'CREATE TABLE IF NOT EXISTS e2e_marker (id INTEGER);',
  ])
  // Specs point projects at the data directory. The real server reads Git
  // state from that path, so it has to be a repository with a commit.
  initRepo(dataDir)
  const child = spawn(
    'node',
    [
      '--import',
      resolve(root, 'e2e/helpers/production-request-loader.mjs'),
      'apps/server/src/index.ts',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        FORGE_DATA_DIR: dataDir,
        FORGE_CONFIG: resolve(dataDir, 'forge.toml'),
        FORGE_PORT: String(port),
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  )
  const serverLog = resolve(tmpdir(), `forge-e2e-server-${child.pid}.log`)
  const logStream = (await import('node:fs')).createWriteStream(serverLog)
  child.stdout?.pipe(logStream)
  child.stderr?.pipe(logStream)
  child.once('exit', (code, signal) => {
    logStream.end(`\n[exit code=${code} signal=${signal}]\n`)
  })
  try {
    await new Promise<void>((ready, reject) => {
      let output = ''
      const timer = setTimeout(
        () => reject(new Error(`forge did not start: ${output}`)),
        10_000,
      )
      const onData = (chunk: Buffer) => {
        output += chunk.toString()
        const match = output.match(/FORGE_LISTENING\s+(\d+)/)
        if (!match) return
        clearTimeout(timer)
        if (Number(match[1]) !== port)
          reject(new Error(`forge took port ${match[1]}, not ${port}`))
        else ready()
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.once('error', reject)
    })
  } catch (error) {
    await stopForge(child, dataDir, !options.dataDir)
    throw error
  }
  const baseUrl = `http://127.0.0.1:${port}`
  try {
    // The composer hides every harness without an account, so a fresh database
    // leaves Send disabled. Seed the one account the fixture harness needs.
    await ensureMockAccount(baseUrl)
  } catch (error) {
    await stopForge(child, dataDir, !options.dataDir)
    throw error
  }
  return {
    baseUrl,
    dataDir,
    stop: async () => stopForge(child, dataDir, !options.dataDir),
  }
}

async function reservePort(): Promise<number> {
  const server = createServer()
  try {
    await new Promise<void>((done, fail) => {
      server.once('error', fail)
      server.listen(0, '127.0.0.1', done)
    })
    const address = server.address()
    if (typeof address === 'string' || address === null)
      throw new Error('could not reserve a port for the e2e server')
    return address.port
  } finally {
    await new Promise<void>((done) => server.close(() => done()))
  }
}

function initRepo(dataDir: string): void {
  const git = (...args: string[]) =>
    spawnSync('git', ['-C', dataDir, ...args], { stdio: 'ignore' })
  git('init', '--initial-branch=main')
  git('config', 'user.email', 'e2e@forge.test')
  git('config', 'user.name', 'Forge E2E')
  git('commit', '--allow-empty', '-m', 'e2e base')
}

async function ensureMockAccount(baseUrl: string): Promise<void> {
  const existing = (await (
    await fetch(`${baseUrl}/api/harness-accounts?harness=mock`)
  ).json()) as unknown[]
  if (existing.length > 0) return
  const created = await fetch(`${baseUrl}/api/harness-accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      harnessKey: 'mock',
      label: 'E2E fixture account',
      kind: 'mock',
      adapterKind: 'acp',
    }),
  })
  if (!created.ok)
    throw new Error(
      `could not seed the mock account: ${created.status} ${await created.text()}`,
    )
}

export async function stopForge(
  child: ChildProcess,
  dataDir?: string,
  remove = true,
): Promise<void> {
  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
  await new Promise<void>((done) => {
    if (child.exitCode !== null) done()
    else child.once('exit', () => done())
  })
  if (remove && dataDir) await rm(dataDir, { recursive: true, force: true })
}
