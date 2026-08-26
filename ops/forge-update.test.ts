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

async function fixture(mode: 'same' | 'update' | 'rollback' | 'active') {
  const root = await mkdtemp(join(tmpdir(), 'forge-update-'))
  dirs.push(root)
  const tools = join(root, 'tools')
  const state = join(root, 'state')
  const bin = join(root, 'bin', 'forge')
  await exec('mkdir', ['-p', tools, state, join(root, 'bin')])
  const release = 'v2.0.0'
  const asset = join(root, 'forge')
  await writeFile(asset, '#!/bin/sh\necho new\n')
  const checksum = createHash('sha256')
    .update(await readFile(asset))
    .digest('hex')
  await writeFile(
    join(root, 'release.json'),
    JSON.stringify({
      tagName: release,
      assets: [{ name: 'forge' }, { name: 'checksums.txt' }],
    }),
  )
  await writeFile(join(root, 'checksums.txt'), `${checksum}  forge\n`)
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
  case "$*" in *checksums.txt*) cp "$FORGE_FIXTURE/checksums.txt" "$9/checksums.txt";; *) cp "$FORGE_FIXTURE/forge" "$9/forge";; esac
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
  elif [ "$FORGE_MODE" = update ] && [ ! -e "$FORGE_FIXTURE/health-seen" ]; then touch "$FORGE_FIXTURE/health-seen"; echo '{"ok":true,"version":"v1.0.0"}'
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
    FORGE_STATE_DIR: state,
    FORGE_UPDATE_DIR: join(root, 'update'),
    FORGE_SYSTEMCTL_LOG: join(root, 'systemctl.log'),
    FORGE_HEALTH_ATTEMPTS: '1',
    FORGE_HEALTH_SLEEP: '0',
  }
  return { env, bin, state, root }
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await exec('rm', ['-rf', dir])
})

describe('forge updater', () => {
  it.each([
    ['same', 'no-op'],
    ['update', 'successful update'],
    ['rollback', 'health rollback'],
    ['active', 'active epic skip'],
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
    } else if (mode === 'rollback') expect(binary).toContain('old')
    else expect(binary).toContain('old')
  })
})
