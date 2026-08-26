import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const dirs: string[] = []
const script = join(process.cwd(), 'ops/forge-update')

async function fixture(
  mode: 'same' | 'update' | 'tagged-build' | 'rollback' | 'active' | 'tarball',
) {
  const root = await mkdtemp(join(tmpdir(), 'forge-update-'))
  dirs.push(root)
  const tools = join(root, 'tools')
  const state = join(root, 'state')
  const bin = join(root, 'bin', 'forge')
  const lib = join(root, 'lib')
  await exec('mkdir', ['-p', tools, state, join(root, 'bin')])
  const release = 'v2.0.0'
  const asset = join(root, 'forge')
  await writeFile(asset, '#!/bin/sh\necho new\n')
  const checksum = createHash('sha256')
    .update(await readFile(asset))
    .digest('hex')
  let assets = [{ name: 'forge' }, { name: 'checksums.txt' }]
  let checksums = `${checksum}  forge\n`
  if (mode === 'tarball') {
    const tree = join(root, 'fixture-tree', 'forge-linux-x64')
    await exec('mkdir', ['-p', join(tree, 'apps/server/src')])
    await writeFile(join(tree, 'apps/server/src/index.js'), '// new bundle\n')
    await exec('tar', [
      '-czf',
      join(root, 'forge-linux-x64.tar.gz'),
      '-C',
      join(root, 'fixture-tree'),
      'forge-linux-x64',
    ])
    const tarChecksum = createHash('sha256')
      .update(await readFile(join(root, 'forge-linux-x64.tar.gz')))
      .digest('hex')
    assets = [{ name: 'forge-linux-x64.tar.gz' }, { name: 'checksums.txt' }]
    checksums = `${tarChecksum}  forge-linux-x64.tar.gz\n`
  }
  await writeFile(
    join(root, 'release.json'),
    JSON.stringify({ tagName: release, assets }),
  )
  await writeFile(join(root, 'checksums.txt'), checksums)
  await writeFile(
    join(state, 'installed-version'),
    mode === 'same' ? release : 'v1.0.0',
  )
  await writeFile(bin, '#!/bin/sh\necho old\n')
  await chmod(bin, 0o755)
  await writeFile(
    join(tools, 'gh'),
    `#!/bin/sh
if [ "$2" = "view" ]; then cat "$FORGE_FIXTURE/release.json"; exit 0; fi
if [ "$2" = "download" ]; then
  case "$*" in
    *checksums.txt*) cp "$FORGE_FIXTURE/checksums.txt" "$9/checksums.txt";;
    *.tar.gz*) cp "$FORGE_FIXTURE/forge-linux-x64.tar.gz" "$9/forge-linux-x64.tar.gz";;
    *) cp "$FORGE_FIXTURE/forge" "$9/forge";;
  esac
fi
`,
  )
  await writeFile(
    join(tools, 'curl'),
    `#!/bin/sh
case "$*" in *api/status*)
  [ "$FORGE_MODE" = active ] && echo '{"epicRuns":{"running":1}}' || echo '{"epicRuns":{"running":0}}'
;; *)
  if [ "$FORGE_MODE" = rollback ]; then echo '{"ok":false,"version":"v1.0.0"}'
  elif [ "$FORGE_MODE" = tagged-build ]; then
    if [ ! -e "$FORGE_FIXTURE/health-seen" ]; then touch "$FORGE_FIXTURE/health-seen"; echo '{"ok":true,"version":"v1.0.0"}'
    else echo '{"ok":true,"version":"v2.0.0-abc1234"}'; fi
  elif { [ "$FORGE_MODE" = update ] || [ "$FORGE_MODE" = tarball ]; } && [ ! -e "$FORGE_FIXTURE/health-seen" ]; then touch "$FORGE_FIXTURE/health-seen"; echo '{"ok":true,"version":"v1.0.0"}'
  else echo '{"ok":true,"version":"v2.0.0"}'; fi
;; esac
`,
  )
  await writeFile(
    join(tools, 'systemctl'),
    '#!/bin/sh\necho "$*" >> "$FORGE_SYSTEMCTL_LOG"\n',
  )
  for (const name of ['gh', 'curl', 'systemctl'])
    await chmod(join(tools, name), 0o755)
  const env = {
    ...process.env,
    PATH: `${tools}:${process.env.PATH}`,
    FORGE_FIXTURE: root,
    FORGE_MODE: mode,
    FORGE_BIN: bin,
    FORGE_LIB_DIR: lib,
    FORGE_STATE_DIR: state,
    FORGE_UPDATE_DIR: join(root, 'update'),
    FORGE_SYSTEMCTL_LOG: join(root, 'systemctl.log'),
    FORGE_HEALTH_ATTEMPTS: '1',
    FORGE_HEALTH_SLEEP: '0',
  }
  return { env, bin, state, root, lib }
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await exec('rm', ['-rf', dir])
})

describe('forge updater', () => {
  it.each([
    ['same', 'no-op'],
    ['update', 'successful update'],
    ['tagged-build', 'tagged build health'],
    ['rollback', 'health rollback'],
    ['active', 'active epic skip'],
    ['tarball', 'tree swap from release archive'],
  ] as const)('%s path: %s', async (mode) => {
    const f = await fixture(mode)
    const result = await exec(script, [], { env: f.env }).catch(
      (error) => error,
    )
    if (mode === 'rollback') expect(result.code).not.toBe(0)
    else expect(result.code ?? 0).toBe(0)
    const installed = await readFile(join(f.state, 'installed-version'), 'utf8')
    const binary = await readFile(f.bin, 'utf8')
    if (mode === 'update') {
      expect(installed).toBe('v2.0.0\n')
      expect(binary).toContain('new')
    } else if (mode === 'tarball') {
      expect(installed).toBe('v2.0.0\n')
      expect(binary).toContain('lib/apps/server/src/index.js')
      const bundle = await readFile(
        join(f.lib, 'apps/server/src/index.js'),
        'utf8',
      )
      expect(bundle).toContain('new bundle')
    } else if (mode === 'rollback') expect(binary).toContain('old')
    else if (mode === 'tagged-build') expect(binary).toContain('new')
    else expect(binary).toContain('old')
  })
})
