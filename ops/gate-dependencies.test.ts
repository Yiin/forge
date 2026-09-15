import { afterEach, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const scratches: string[] = []
afterEach(() => {
  for (const path of scratches.splice(0))
    rmSync(path, { recursive: true, force: true })
})
function fixture() {
  const scratch = mkdtempSync(join(tmpdir(), 'forge gate #'))
  scratches.push(scratch)
  const root = join(scratch, 'checkout')
  const source = join(scratch, 'source')
  for (const directory of [
    root,
    source,
    join(root, 'scripts'),
    join(root, 'apps/server'),
    join(root, 'packages/protocol'),
    join(root, 'e2e'),
  ])
    mkdirSync(directory, { recursive: true })
  copyFileSync(
    resolve('scripts/isolate-gate-dependencies.mjs'),
    join(root, 'scripts/isolate-gate-dependencies.mjs'),
  )
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ workspaces: ['apps/*', 'packages/*', 'e2e'] }),
  )
  const run = () =>
    spawnSync('node', [join(root, 'scripts/isolate-gate-dependencies.mjs')], {
      encoding: 'utf8',
    })
  return { root, source, run }
}
function file(path: string, value = 'original') {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

it('quarantines runner depth-two Bun links and workspace dependencies without changing source files', () => {
  const { root, source, run } = fixture()
  const packagePath = join(source, 'node_modules/.bun/node-pty@1.1.0')
  file(join(packagePath, 'node_modules/node-pty/package.json'))
  mkdirSync(join(root, 'node_modules/.bun'), { recursive: true })
  symlinkSync(packagePath, join(root, 'node_modules/.bun/node-pty@1.1.0'))
  symlinkSync(
    '.bun/node-pty@1.1.0/node_modules/node-pty',
    join(root, 'node_modules/node-pty'),
  )
  const workspace = join(root, 'apps/server/node_modules')
  mkdirSync(workspace)
  symlinkSync('../../../node_modules/node-pty', join(workspace, 'node-pty'))
  file(join(root, 'e2e/node_modules/sentinel'))
  expect(realpathSync(join(root, 'node_modules/node-pty'))).toContain(source)
  expect(run().status).toBe(0)
  expect(existsSync(join(root, 'node_modules'))).toBe(false)
  expect(existsSync(workspace)).toBe(false)
  const backups = readdirSync(join(root, '.native-build')).filter((name) =>
    name.startsWith('dependencies-'),
  )
  expect(backups).toHaveLength(1)
  const backup = join(root, '.native-build', backups[0]!)
  expect(
    lstatSync(
      join(backup, 'node_modules/.bun/node-pty@1.1.0'),
    ).isSymbolicLink(),
  ).toBe(true)
  expect(
    lstatSync(
      join(backup, 'apps/server/node_modules/node-pty'),
    ).isSymbolicLink(),
  ).toBe(true)
  expect(readFileSync(join(backup, 'e2e/node_modules/sentinel'), 'utf8')).toBe(
    'original',
  )
  expect(
    readFileSync(
      join(packagePath, 'node_modules/node-pty/package.json'),
      'utf8',
    ),
  ).toBe('original')
  expect(run().status).toBe(0)
  expect(
    readdirSync(join(root, '.native-build')).filter((name) =>
      name.startsWith('dependencies-'),
    ),
  ).toHaveLength(1)
})

it('keeps owned Bun dependencies and local workspace links', () => {
  const { root, run } = fixture()
  file(join(root, 'node_modules/.bun/pkg/node_modules/pkg/index.js'))
  symlinkSync('.bun/pkg/node_modules/pkg', join(root, 'node_modules/pkg'))
  symlinkSync('../packages/protocol', join(root, 'node_modules/protocol'))
  expect(run().status).toBe(0)
  expect(readFileSync(join(root, 'node_modules/pkg/index.js'), 'utf8')).toBe(
    'original',
  )
  expect(readdirSync(join(root, '.native-build'))).toEqual(['bun-cache'])
})

it('preserves a dangling borrowed dependency instead of following it', () => {
  const { root, source, run } = fixture()
  symlinkSync(join(source, 'missing'), join(root, 'node_modules'))
  expect(run().status).toBe(0)
  const backup = readdirSync(join(root, '.native-build')).find((name) =>
    name.startsWith('dependencies-'),
  )!
  expect(
    lstatSync(
      join(root, '.native-build', backup, 'node_modules'),
    ).isSymbolicLink(),
  ).toBe(true)
})

it('refuses external cache links before dependency changes', () => {
  const { root, source, run } = fixture()
  mkdirSync(join(root, '.native-build'))
  symlinkSync(source, join(root, '.native-build/bun-cache'))
  file(join(root, 'node_modules/sentinel'))
  const result = run()
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('Gate cache resolves outside the checkout')
  expect(readFileSync(join(root, 'node_modules/sentinel'), 'utf8')).toBe(
    'original',
  )
  expect(readdirSync(source)).toEqual([])
})

it('finds external links behind a local store alias while handling directory cycles', () => {
  const { root, source, run } = fixture()
  file(join(source, 'package/sentinel'))
  mkdirSync(join(root, 'store'))
  symlinkSync('.', join(root, 'store/cycle'))
  symlinkSync(join(source, 'package'), join(root, 'store/pooled'))
  mkdirSync(join(root, 'node_modules'))
  symlinkSync('../store', join(root, 'node_modules/.bun'))
  expect(run().status).toBe(0)
  expect(existsSync(join(root, 'node_modules'))).toBe(false)
  expect(lstatSync(join(root, 'store/pooled')).isSymbolicLink()).toBe(true)
  expect(readFileSync(join(source, 'package/sentinel'), 'utf8')).toBe(
    'original',
  )
})

it('does not quarantine a local directory cycle', () => {
  const { root, run } = fixture()
  mkdirSync(join(root, 'store'))
  symlinkSync('.', join(root, 'store/cycle'))
  mkdirSync(join(root, 'node_modules'))
  symlinkSync('../store', join(root, 'node_modules/first'))
  symlinkSync('../store', join(root, 'node_modules/second'))
  expect(run().status).toBe(0)
  expect(existsSync(join(root, 'node_modules'))).toBe(true)
  expect(readdirSync(join(root, '.native-build'))).toEqual(['bun-cache'])
})
