import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixture } from './fixtures.js'
import { runGit } from '../git/exec.js'
import type { WorkspaceEntry } from '@forge/protocol/workspace'

describe('bounded workspace listing and path search', () => {
  it('pages a stable directory and rejects changed or mismatched cursors', async () => {
    const f = await fixture()
    for (let i = 0; i < 503; i++)
      await writeFile(join(f.root, `f${String(i).padStart(3, '0')}`), '')
    await mkdir(join(f.root, 'z-directory'))
    const first = await (await f.app.request(f.url('files'))).json()
    expect(first.entries.length).toBe(500)
    expect(first.entries[0].type).toBe('directory')
    expect(first.truncated).toBe(false)
    const second = await (
      await f.app.request(f.url('files', { cursor: first.nextCursor }))
    ).json()
    expect(second.entries.length).toBe(5)
    expect(second.nextCursor).toBeNull()
    expect(
      new Set([...first.entries, ...second.entries].map((entry) => entry.path))
        .size,
    ).toBe(505)
    expect(
      (
        await f.app.request(
          f.url('files', { cursor: first.nextCursor, includeHidden: 'false' }),
        )
      ).status,
    ).toBe(409)
    await writeFile(join(f.root, 'f000'), 'changed')
    const stale = await f.app.request(
      f.url('files', { cursor: first.nextCursor }),
    )
    expect(stale.status).toBe(409)
    expect((await stale.json()).reason).toBe('listing_changed')
  })
  it('keeps hidden/ignored controls independent and uses Git nested negation for tracked paths', async () => {
    const f = await fixture(true)
    await mkdir(join(f.root, 'sub'))
    await writeFile(join(f.root, '.gitignore'), '*.log\nfile.txt\n')
    await writeFile(join(f.root, 'sub/.gitignore'), '!keep.log\n')
    for (const name of [
      '.hidden',
      '.hidden.log',
      'ignored.log',
      'sub/keep.log',
      'sub/drop.log',
    ])
      await writeFile(join(f.root, name), '')
    await writeFile(join(f.root, '.forge-save-owned'), 'hidden')
    const list = async (flags: Record<string, string> = {}) =>
      (await (await f.app.request(f.url('files', flags))).json())
        .entries as WorkspaceEntry[]
    const normal = await list()
    expect(normal.map((e) => e.name)).toContain('.hidden')
    expect(normal.map((e) => e.name)).not.toContain('file.txt')
    const all = await list({ includeIgnored: 'true', includeHidden: 'false' })
    expect(all.find((e) => e.name === 'file.txt')?.ignored).toBe(true)
    expect(all.map((e) => e.name)).not.toContain('.hidden')
    const visible = await list({ includeIgnored: 'true' })
    expect(visible.map((e) => e.name)).not.toContain('.git')
    expect(visible.map((e) => e.name)).not.toContain('.forge-save-owned')
    const nested = await list({ path: 'sub' })
    expect(nested.map((e) => e.name)).toContain('keep.log')
    expect(nested.map((e) => e.name)).not.toContain('drop.log')
    const search = await (
      await f.app.request(f.url('search', { query: 'log' }))
    ).json()
    expect(search.matches.map((e: WorkspaceEntry) => e.path)).toEqual([
      'sub/keep.log',
    ])
    const index = await runGit(f.root, ['diff', '--cached', '--name-only'])
    expect(index.stdout).toBe('')
  })
  it('returns empty/plain directories and bounded ranked matches without searching content', async () => {
    const f = await fixture()
    await mkdir(join(f.root, 'empty'))
    const empty = await (
      await f.app.request(f.url('files', { path: 'empty' }))
    ).json()
    expect(empty.entries).toEqual([])
    await writeFile(join(f.root, 'needle'), '')
    await writeFile(join(f.root, 'needle-extra'), '')
    await writeFile(join(f.root, 'content'), 'needle')
    for (let i = 0; i < 210; i++)
      await writeFile(join(f.root, `match-needle-${i}`), '')
    const result = await (
      await f.app.request(f.url('search', { query: 'needle' }))
    ).json()
    expect(result.matches.length).toBe(200)
    expect(result.matches[0].path).toBe('needle')
    expect(result.matches[1].path).toBe('needle-extra')
    expect(
      result.matches.some((e: WorkspaceEntry) => e.path === 'content'),
    ).toBe(false)
    expect(result.matches.every((e: WorkspaceEntry) => !e.ignored)).toBe(true)
  })
  it('reports an explicit partial search when a directory disappears during traversal', async () => {
    const f = await fixture(false, {
      beforeDirectoryOpen: async () => {
        throw Object.assign(new Error('Directory vanished'), { code: 'ENOENT' })
      },
    })
    await mkdir(join(f.root, 'gone'))
    const response = await f.app.request(f.url('search', { query: 'gone' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      truncated: true,
      partialReasons: ['unreadable'],
    })
  })
})
