import * as childProcess from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const helper = join(
  dirname(fileURLToPath(import.meta.url)),
  'manager-helper.mjs',
)
export const execFile: typeof childProcess.execFile = ((
  command: string,
  args: string[],
  options: object,
  callback: unknown,
) => {
  if (command !== '/usr/bin/systemctl')
    throw new Error('Unexpected manager command')
  return childProcess.execFile(
    process.execPath,
    [helper, 'control', ...args],
    options,
    callback as never,
  )
}) as typeof childProcess.execFile
export const spawn: typeof childProcess.spawn = ((
  command: string,
  args: string[],
  options: object,
) => {
  if (command !== '/usr/bin/systemd-run')
    throw new Error('Unexpected service command')
  return childProcess.spawn(process.execPath, [helper, 'run', ...args], options)
}) as typeof childProcess.spawn
