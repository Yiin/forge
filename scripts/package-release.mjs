#!/usr/bin/env node
import { createHash } from 'node:crypto'
import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const targetArgument = process.argv[2]
if (!targetArgument)
  throw new Error('Usage: package-release.mjs <external-target>')
const target = resolve(targetArgument)

if (target === root || target.startsWith(`${root}/`))
  throw new Error('Release target must be outside the checkout')
const parent = await realpath(dirname(target))
if (parent === root || parent.startsWith(`${root}/`))
  throw new Error('Release target parent must be outside the checkout')
try {
  await mkdir(target)
} catch (error) {
  if (error.code === 'EEXIST')
    throw new Error('Release target must not already exist')
  throw error
}

const files = [
  ['apps/server/src/index.js', join(root, 'dist', 'forge-server.js')],
  ['apps/server/package.json', join(root, 'apps/server/package.json')],
  [
    'apps/server/src/build/Release/pty.node',
    join(root, 'apps/server/node_modules/node-pty/build/Release/pty.node'),
  ],
  [
    'apps/server/src/build/Release/spawn-helper',
    join(root, 'apps/server/node_modules/node-pty/build/Release/spawn-helper'),
  ],
]

async function copyFile(destination, source) {
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { force: true })
}

await exec('bun', ['run', 'build'], { cwd: root })
await exec(
  'bun',
  [
    'build',
    '--target=node',
    'apps/server/src/index.ts',
    '--outfile',
    'dist/forge-server.js',
  ],
  { cwd: root },
)
await exec('node', ['scripts/build-node-pty.mjs'], { cwd: root })
await exec('bun', ['run', 'build:kimi-guardian'], { cwd: root })
await exec('bun', ['run', 'build:cursor-sidecar'], { cwd: root })

for (const [destination, source] of files) {
  try {
    await stat(source)
  } catch (error) {
    if (destination.endsWith('spawn-helper') && error.code === 'ENOENT')
      continue
    throw new Error(`Missing release input: ${source}`)
  }
  await copyFile(join(target, destination), source)
}
await cp(join(root, 'apps/server/drizzle'), join(target, 'apps/drizzle'), {
  recursive: true,
})
await cp(join(root, 'apps/web/dist'), join(target, 'web'), { recursive: true })
await cp(
  join(root, 'apps/server/src/cursor-sidecar'),
  join(target, 'apps/server/src/cursor-sidecar'),
  { recursive: true },
)
await copyFile(
  join(target, 'apps/server/src/kimi-guardian.js'),
  join(root, 'dist/kimi-guardian.js'),
)
await copyFile(
  join(target, 'apps/server/src/build/Release/forge-owned-build.json'),
  join(
    root,
    'apps/server/node_modules/node-pty/build/Release/forge-owned-build.json',
  ),
)
await copyFile(
  join(target, 'apps/server/src/build/Release/node-pty.LICENSE'),
  join(root, 'apps/server/node_modules/node-pty/LICENSE'),
)
for (const [destination, source] of [
  [
    'apps/server/src/harnesses/pi/PI-LICENSE',
    'apps/server/src/harnesses/pi/PI-LICENSE',
  ],
  [
    'apps/server/src/harnesses/pi/NOTICE.md',
    'apps/server/src/harnesses/pi/NOTICE.md',
  ],
  [
    'apps/server/src/harnesses/kimi/NOTICE.md',
    'apps/server/src/harnesses/kimi/NOTICE.md',
  ],
])
  await copyFile(join(target, destination), join(root, source))
await cp(
  join(root, 'THIRD_PARTY_NOTICES.md'),
  join(target, 'THIRD_PARTY_NOTICES.md'),
)

const inventory = []
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink())
      throw new Error(`Release contains symlink: ${path}`)
    if (entry.isDirectory()) await visit(path)
    else if (entry.isFile()) {
      const bytes = await readFile(path)
      const info = await stat(path)
      inventory.push({
        path: relative(target, path),
        bytes: info.size,
        mode: info.mode & 0o777,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
    }
  }
}
await visit(target)
await writeFile(
  join(target, 'manifest.json'),
  `${JSON.stringify({ version: 1, files: inventory }, null, 2)}\n`,
)
console.log(JSON.stringify({ target, files: inventory.length }))
