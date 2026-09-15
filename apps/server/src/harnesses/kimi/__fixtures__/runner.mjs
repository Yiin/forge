// An owned process runner. It finalizes the actual guardian across interruption.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { appendFileSync, readFileSync } from 'node:fs'

const { artifact, authority, limits, log, runtime } = JSON.parse(
  process.argv[2],
)
function identity(pid) {
  const value = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const fields = value.slice(value.lastIndexOf(')') + 2).split(' ')
  return { pid, startTicks: fields[19] }
}
function evidence(phase, detail = {}) {
  appendFileSync(
    log,
    JSON.stringify({ phase, runnerPid: process.pid, ...detail }) + '\n',
    { mode: 0o600 },
  )
}
evidence('owned_runner.started', { original: identity(process.pid) })
const child = spawn(
  process.execPath,
  [
    fileURLToPath(new URL('./guardian.mjs', import.meta.url)),
    artifact,
    runtime,
    JSON.stringify(limits),
  ],
  {
    cwd: authority.account.homePath,
    stdio: ['pipe', 'pipe', 'pipe'],
  },
)
evidence('owned_runner.guardian_started', { original: identity(child.pid) })
let buffer = '',
  finalizing = false
const closed = new Promise((resolve) =>
  child.once('close', (code, signal) => {
    evidence('owned_runner.guardian_physical_close', { code, signal })
    resolve()
  }),
)
child.stderr.resume()
child.stdout.on('data', (chunk) => {
  buffer += chunk
  for (
    let offset = buffer.indexOf('\n');
    offset >= 0;
    offset = buffer.indexOf('\n')
  ) {
    const value = JSON.parse(buffer.slice(0, offset))
    buffer = buffer.slice(offset + 1)
    if (value.id === 'init') {
      evidence('owned_runner.initialized', { runtime, result: value })
      process.send?.({ phase: 'ready', result: value })
    }
  }
})
async function finalize(reason) {
  if (finalizing) return
  finalizing = true
  evidence('owned_runner.logical_stop', { reason })
  child.stdin.end()
  await closed
  evidence('owned_runner.finalizer_settled')
  process.disconnect?.()
}
process.on('SIGTERM', () => {
  void finalize('interrupted')
})
process.on('message', () => {
  void finalize('requested')
})
process.on('disconnect', () => {
  void finalize('parent_disconnected')
})
child.stdin.write(
  JSON.stringify({
    id: 'init',
    op: 'initialize',
    authority,
    limits,
    removals: [],
  }) + '\n',
)
