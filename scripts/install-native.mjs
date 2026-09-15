import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.platform === 'linux') {
  const script = fileURLToPath(new URL('./build-node-pty.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exitCode = result.status ?? 1
}
