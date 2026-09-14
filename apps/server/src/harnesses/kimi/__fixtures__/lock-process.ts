import fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { KimiHomeLock, processStartTicks } from '../lock.js'
import { directoryIdentity } from '../authority.js'
import { kimiLimits } from '../limits.js'

const [runtime, homePath, role] = process.argv.slice(2)
const commands = new Set<string>()
const waiting = new Map<string, () => void>()
const receive = (command: unknown) => {
  if (typeof command !== 'string' || commands.size >= 8)
    throw new Error('Invalid fixture command')
  commands.add(command)
  waiting.get(command)?.()
}
process.on('message', receive)
const wait = (command: string) =>
  commands.has(command)
    ? Promise.resolve()
    : new Promise<void>((resolve) => waiting.set(command, resolve))
const report = (value: object) =>
  new Promise<void>((resolve, reject) => {
    process.send!(value, (error) => (error ? reject(error) : resolve()))
  })
const home = await directoryIdentity(homePath, true)
await report({
  phase: 'owned',
  pid: process.pid,
  startTicks: await processStartTicks(process.pid),
  boot: (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
  home,
  runtime,
  checkout: process.cwd(),
})

const handles = new Set<FileHandle>()
const open = fs.open.bind(fs)
let selected = false
fs.open = async (...args) => {
  const path = String(args[0])
  if (role === 'contender' && path.endsWith('/registry.json')) {
    await report({ phase: 'registry_read' })
    await wait('resume')
  }
  const file = await open(...args)
  handles.add(file)
  const close = file.close.bind(file)
  file.close = async () => {
    await close()
    handles.delete(file)
  }
  if (
    role === 'creator' &&
    !selected &&
    /\/registry\.(?:lock|candidate)$/.test(path)
  ) {
    selected = true
    const sync = file.sync.bind(file)
    file.sync = async () => {
      await report({ phase: 'candidate_sync', fd: file.fd })
      await wait('resume')
      await sync()
    }
  }
  return file
}
syncBuiltinESMExports()

let lock: KimiHomeLock | undefined
try {
  await wait('start')
  try {
    lock = await KimiHomeLock.acquire(home, kimiLimits(), runtime)
    await report({ phase: 'result', status: 'accepted', handles: handles.size })
  } catch (error) {
    await report({
      phase: 'result',
      status: 'rejected',
      code: (error as { code?: string }).code,
      handles: handles.size,
    })
  }
  await wait('release')
  await lock?.release(true)
  await report({ phase: 'settled', handles: handles.size })
} finally {
  fs.open = open
  syncBuiltinESMExports()
  process.off('message', receive)
  process.disconnect()
}
