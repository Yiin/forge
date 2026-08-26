import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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
  const tomlEnv = Object.entries(options.fakeAgentEnv ?? {})
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join('\n')
  await writeFile(
    resolve(dataDir, 'forge.toml'),
    [
      '[harness.fake-acp-agent]',
      'protocol = "acp"',
      'command = "bun"',
      `args = [${JSON.stringify(fakeAgent)}]`,
      ...(tomlEnv ? ['[harness.fake-acp-agent.env]', tomlEnv] : []),
      '',
    ].join('\n'),
  )
  spawnSync('sqlite3', [
    resolve(dataDir, 'forge.db'),
    'CREATE TABLE IF NOT EXISTS e2e_marker (id INTEGER);',
  ])
  const child = spawn('bun', ['run', 'apps/server/src/index.ts'], {
    cwd: root,
    env: {
      ...process.env,
      FORGE_DATA_DIR: dataDir,
      FORGE_PORT: '0',
      FORGE_E2E: '1',
      ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  const serverLog = resolve(tmpdir(), `forge-e2e-server-${child.pid}.log`)
  const logStream = (await import('node:fs')).createWriteStream(serverLog)
  child.stdout?.pipe(logStream)
  child.stderr?.pipe(logStream)
  child.once('exit', (code, signal) => {
    logStream.end(`\n[exit code=${code} signal=${signal}]\n`)
  })
  let port: number
  try {
    port = await new Promise<number>((resolvePort, reject) => {
      let output = ''
      const timer = setTimeout(
        () => reject(new Error(`forge did not start: ${output}`)),
        10_000,
      )
      const onData = (chunk: Buffer) => {
        output += chunk.toString()
        const match = output.match(/FORGE_LISTENING\s+(\d+)/)
        if (match) {
          clearTimeout(timer)
          resolvePort(Number(match[1]))
        }
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.once('error', reject)
    })
  } catch (error) {
    await stopForge(child, dataDir, !options.dataDir)
    throw error
  }
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    dataDir,
    stop: async () => stopForge(child, dataDir, !options.dataDir),
  }
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
