import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const scratch = await mkdtemp(join(tmpdir(), 'forge-client-pack-'))
const packed = await run('bun', ['pm', 'pack', '--destination', scratch], {
  cwd: import.meta.dir + '/..',
})
const tarball = packed.stdout.match(/(\/[^\s]+\.tgz)/)?.[1]
if (!tarball) throw new Error('bun pm pack did not report a tarball')
await run('bun', ['add', 'zod', `file:${tarball}`], { cwd: scratch })
await writeFile(
  join(scratch, 'check.ts'),
  "import { createForgeClient } from 'forge-client'\ncreateForgeClient('http://localhost')\n",
)
await run(
  'bun',
  [
    '-e',
    "await import('forge-client').then(({ createForgeClient }) => createForgeClient('http://localhost'))",
  ],
  { cwd: scratch },
)
await run(
  'bunx',
  [
    'tsc',
    '--noEmit',
    '--strict',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--target',
    'ES2022',
    'check.ts',
  ],
  { cwd: scratch },
)
console.log(`verified ${tarball}`)
