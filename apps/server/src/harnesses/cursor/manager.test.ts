import { mkdtemp, writeFile, readFile, lstat, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { NativeProcess } from '../process.js'
import { CursorWire } from './wire.js'
import { cursorLimits, serviceGrant } from './limits.js'
import { writeMarker } from './store.js'
import { processIdentity } from './container.js'
import { nativeBootstrapOverrides } from './launch.js'

it('starts the actual bootstrap without manager preloads or manager secrets and refuses the fake container proof', async () => {
  const root = await mkdtemp('/tmp/forge-cursor-manager-'),
    limits = cursorLimits(),
    generation = randomUUID(),
    fence = join(root, 'writer-fence.json')
  const identity = {
    unit: `forge-cursor-${randomUUID()}.service`,
    nonce: randomUUID(),
    generation,
    leaseId: randomUUID(),
    grant: serviceGrant(limits),
    boot: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    host: (await readFile('/etc/machine-id', 'utf8')).trim(),
  }
  let child: NativeProcess | undefined
  try {
    await promisify(execFile)(
      'bun',
      ['apps/server/test/fixtures/build-cursor-manager.mjs', root],
      { cwd: process.cwd(), timeout: 30000, maxBuffer: 4096 },
    )
    await writeFile(
      join(root, 'injection.cjs'),
      `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'injected'))},'injected')`,
      { mode: 0o600 },
    )
    await writeMarker(fence, { state: 'dirty', identity }, limits, true)
    await expect(
      NativeProcess.start(
        {
          command: process.execPath,
          args: [join(root, 'guardian.mjs'), generation],
          cwd: root,
          env: nativeBootstrapOverrides(process.env),
        },
        async (process) => {
          child = process
          const wire = new CursorWire(
            process.child.stdin,
            process.child.stdout,
            generation,
            limits,
            () => {
              throw new Error('Unexpected readiness')
            },
          )
          process.ownTransport(wire.transport)
          return wire.request('initialize', {
            identity,
            node: globalThis.process.execPath,
            args: ['--max-old-space-size=512'],
            entry: resolve('apps/server/src/cursor-sidecar/sidecar.mjs'),
            cwd: root,
            fence,
            stateRoot: root,
            removed: [],
          })
        },
      ),
    ).rejects.toThrow('cursor_container_unavailable')
    const observed = JSON.parse(
      await readFile(join(root, 'observed.json'), 'utf8'),
    )
    expect(observed).toMatchObject({
      secretInArguments: false,
      secretBeforeGrant: false,
      preloadBeforeGrant: false,
    })
    expect(observed.unset).toContain('FORGE_FAKE_MANAGER_SECRET')
    expect(
      await lstat(join(root, 'injected')).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    expect(
      JSON.stringify(JSON.parse(await readFile(fence, 'utf8'))),
    ).not.toContain('synthetic-manager-secret')
    const pid = Number(await readFile(join(root, 'service-pid'), 'utf8'))
    await vi.waitFor(async () =>
      expect(
        await processIdentity(pid).then(
          () => true,
          () => false,
        ),
      ).toBe(false),
    )
  } finally {
    await child?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
