import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [archiveArg, directoryArg] = process.argv.slice(2)
if (!archiveArg || !directoryArg)
  throw new Error('Usage: terminal-release-smoke.mjs <archive> <new-directory>')
if (process.versions.node !== '24.21.0' || process.versions.bun)
  throw new Error('Extracted smoke requires actual Node 24.21.0')
const archive = resolve(archiveArg),
  directory = resolve(directoryArg)
if (existsSync(directory)) throw new Error('Smoke directory already exists')
mkdirSync(directory, { recursive: true })
const extract = spawnSync('/usr/bin/tar', ['-xzf', archive, '-C', directory], {
  encoding: 'utf8',
  timeout: 30000,
})
if (extract.status !== 0) throw new Error(extract.stderr)
const roots = readdirSync(directory)
if (roots.length !== 1)
  throw new Error('Release must contain one root directory')
const entry = join(directory, roots[0], 'apps/server/src/index.js')
const home = join(directory, 'home'),
  data = join(directory, 'data'),
  cwd = join(directory, 'unrelated')
for (const path of [home, data, cwd]) mkdirSync(path)
const driver = join(directory, 'driver.mjs')
cpSync(
  fileURLToPath(new URL('./terminal-release-driver.mjs', import.meta.url)),
  driver,
  { errorOnExist: true, force: false },
)
const env = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  FORGE_ACCOUNTS_DIR: join(home, 'accounts'),
  FORGE_DATA_DIR: data,
  FORGE_CONFIG: join(data, 'forge.toml'),
  FORGE_WEB_DIR: join(directory, roots[0], 'web'),
  NODE_ENV: 'test',
  LANG: 'C.UTF-8',
}
// The driver uses only Node builtins and the extracted server/native files.
const log = openSync(join(directory, 'driver.log'), 'wx')
const result = spawnSync(process.execPath, [driver, entry, data], {
  cwd,
  env,
  encoding: 'utf8',
  stdio: ['inherit', log, log],
})
closeSync(log)
const hash = (path) =>
  createHash('sha256').update(readFileSync(path)).digest('hex')
writeFileSync(
  join(directory, 'receipt.json'),
  `${JSON.stringify({ archive, archiveSha256: hash(archive), entry, entrySha256: hash(entry), driverSha256: hash(driver), node: process.execPath, nodeSha256: hash(process.execPath), cwd, environment: env, status: result.status, error: result.error?.message ?? null }, null, 2)}\n`,
)
if (result.error || result.status !== 0)
  throw new Error(
    `Extracted terminal smoke failed; inspect ${join(directory, 'driver.log')}`,
  )
console.log(
  JSON.stringify({ receipt: join(directory, 'receipt.json'), passed: true }),
)
