import {
  chmod,
  mkdir,
  readFile,
  readdir,
  readlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixture, until } from './fixtures.js'
import { createProject } from '../db/queries.js'
import { runGit } from '../git/exec.js'

async function ownedDescriptors(root: string) {
  const descriptors = await readdir('/proc/self/fd')
  const paths: string[] = []
  for (const descriptor of descriptors) {
    const path = await readlink(`/proc/self/fd/${descriptor}`).catch(() => '')
    if (path.startsWith(root)) paths.push(path)
  }
  return paths.sort()
}
describe('workspace operational bounds and unavailable states', () => {
  it('reports repair-only mode when one native directory watch fails', async () => {
    const f = await fixture(false, {
      beforeWatchDirectory: async (path) => {
        if (path) throw new Error('Watch registration unavailable')
      },
    })
    await mkdir(join(f.root, 'child'))
    const sub = await f.service.watches.subscribe(f.target)
    expect(await sub.next()).toMatchObject({
      mode: 'repair_only',
      resyncRequired: true,
    })
    sub.close()
    await f.service.close()
    expect(f.service.diagnostics.watchDirectories).toBe(0)
  })
  it('returns an explicit unavailable state when safe descriptor paths are unsupported', async () => {
    const f = await fixture()
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    try {
      Object.defineProperty(process, 'platform', {
        ...platform,
        value: 'unsupported',
      })
      const response = await f.app.request(f.url('file', { path: 'file.txt' }))
      expect(response.status).toBe(503)
      expect((await response.json()).error).toBe('unavailable')
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })
  it('closes actual file and watch descriptors on HEAD, cancellation, and shutdown', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'media.mp4'), Buffer.alloc(1024 * 1024))
    const before = await ownedDescriptors(f.dir)
    const sub = await f.service.watches.subscribe(f.target)
    await sub.next()
    const head = await f.app.request(f.url('media', { path: 'media.mp4' }), {
      method: 'HEAD',
    })
    expect(head.status).toBe(200)
    const media = await f.app.request(f.url('media', { path: 'media.mp4' }))
    await media.body!.cancel()
    await f.service.close()
    await until(
      () => ownedDescriptors(f.dir),
      (paths) => JSON.stringify(paths) === JSON.stringify(before),
    )
  })
  it('bounds scans of more than 50,000 real entries and marks the partial page', async () => {
    const f = await fixture()
    for (let i = 0; i < 50_050; i += 50)
      await Promise.all(
        Array.from({ length: 50 }, (_, j) =>
          writeFile(join(f.root, `entry-${i + j}`), ''),
        ),
      )
    const response = await f.app.request(f.url('files'))
    expect(response.status).toBe(200)
    const page = await response.json()
    expect(page.entries.length).toBe(500)
    expect(page.truncated).toBe(true)
    expect(
      page.partialReasons.some((reason: string) =>
        ['scan_limit', 'timeout', 'metadata_limit'].includes(reason),
      ),
    ).toBe(true)
  }, 30_000)
  it('keeps bounded Git stdin/stdout and separate machine output without optional index writes', async () => {
    const f = await fixture(true)
    await writeFile(join(f.root, '.gitignore'), '*.ignored\n')
    const index = await readFile(join(f.root, '.git/index'))
    const result = await runGit(
      f.root,
      ['check-ignore', '--no-index', '-z', '--stdin'],
      false,
      { stdin: 'name.ignored\0file.txt\0', readOnly: true },
    )
    expect(result.stdout).toBe('name.ignored\0')
    expect(result.stderr).toBe('')
    expect(await readFile(join(f.root, '.git/index'))).toEqual(index)
    await expect(
      runGit(f.root, ['ls-files'], true, { maxOutputBytes: 2 }),
    ).rejects.toThrow('output limit')
    await expect(
      runGit(f.root, ['check-ignore', '--stdin'], false, {
        maxOutputBytes: 2,
        stdin: 'too large',
      }),
    ).rejects.toThrow('input limit')
    const controller = new AbortController()
    controller.abort()
    await expect(
      runGit(f.root, ['status'], true, { signal: controller.signal }),
    ).rejects.toBeTruthy()
  })
  it('rejects a read-only parent without leaving a temporary file', async () => {
    const f = await fixture()
    const input = await f.input('new')
    await chmod(f.root, 0o555)
    try {
      expect((await f.save(input)).status).toBe(403)
      expect(
        (await readdir(f.root)).some((name) => name.startsWith('.forge-save-')),
      ).toBe(false)
    } finally {
      await chmod(f.root, 0o755)
    }
  })
  it('caps shared watch roots and releases every root', async () => {
    const f = await fixture()
    for (let i = 0; i < 33; i++) {
      const path = join(f.dir, `root-${i}`)
      await mkdir(path)
      const project = createProject(f.db, { path, name: `Root ${i}` })
      const subscribe = f.service.watches.subscribe({
        kind: 'project',
        projectId: project.id,
      })
      if (i < 32) await subscribe
      else await expect(subscribe).rejects.toMatchObject({ status: 429 })
    }
    expect(f.service.diagnostics.watchRoots).toBe(32)
    await f.service.close()
    expect(f.service.diagnostics.watchRoots).toBe(0)
  })
  it('caps native directory registration for more than 8,000 real directories', async () => {
    const f = await fixture()
    for (let i = 0; i < 8050; i += 50)
      await Promise.all(
        Array.from({ length: 50 }, (_, j) =>
          mkdir(join(f.root, `directory-${i + j}`)),
        ),
      )
    const subscription = await f.service.watches.subscribe(f.target)
    expect(await subscription.next()).toMatchObject({
      mode: 'repair_only',
      resyncRequired: true,
    })
    expect(f.service.diagnostics.watchDirectories).toBeLessThanOrEqual(8000)
    await f.service.close()
    expect(f.service.diagnostics.watchDirectories).toBe(0)
  }, 30_000)
})
