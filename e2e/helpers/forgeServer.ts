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
export type LaunchOptions = { env?: Record<string, string>; dataDir?: string }

export async function launchForge(
  options: LaunchOptions = {},
): Promise<ForgeServer> {
  const dataDir = resolve(
    options.dataDir ?? (await mkdtemp(`${tmpdir()}/forge-e2e-`)),
  )
  const tmpRoot = resolve(tmpdir())
  if (dataDir !== tmpRoot && !dataDir.startsWith(`${tmpRoot}/`))
    throw new Error('e2e data directory must be under tmpdir')
  await writeFile(
    resolve(dataDir, 'forge.toml'),
    '[harnesses.fake-acp-agent]\nprotocol = "acp"\ncommand = "bun"\nargs = []\n',
  )
  spawnSync('sqlite3', [
    resolve(dataDir, 'forge.db'),
    'CREATE TABLE IF NOT EXISTS e2e_marker (id INTEGER);',
  ])
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
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
