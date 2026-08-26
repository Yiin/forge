import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fsBrowseRoutes } from './fsBrowse.js'

let root: string
const app = fsBrowseRoutes()

beforeAll(async () => {
  root = await mkdtemp(`${tmpdir()}/forge-fs-`)
  await mkdir(join(root, 'alpha'))
  await mkdir(join(root, 'beta'))
  await mkdir(join(root, '.git'))
  await mkdir(join(root, '.hidden'))
  await writeFile(join(root, 'notes.txt'), 'not a directory')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('GET /api/fs', () => {
  it('lists directories, excluding files and .git', async () => {
    const response = await app.request(
      `/api/fs?path=${encodeURIComponent(root)}`,
    )
    expect(response.status).toBe(200)
    const result = (await response.json()) as {
      path: string
      parent: string | null
      entries: Array<{ name: string; path: string }>
    }
    expect(result.path).toBe(root)
    expect(result.parent).toBe(tmpdir())
    expect(result.entries.map((entry) => entry.name)).toEqual([
      '.hidden',
      'alpha',
      'beta',
    ])
    expect(result.entries[1].path).toBe(join(root, 'alpha'))
  })

  it('reports a null parent at the filesystem root', async () => {
    const response = await app.request('/api/fs?path=%2F')
    expect(response.status).toBe(200)
    const result = (await response.json()) as {
      path: string
      parent: string | null
    }
    expect(result.path).toBe('/')
    expect(result.parent).toBeNull()
  })

  it('rejects a missing directory', async () => {
    const response = await app.request(
      `/api/fs?path=${encodeURIComponent(join(root, 'nope'))}`,
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid path' })
  })

  it('rejects a file path', async () => {
    const response = await app.request(
      `/api/fs?path=${encodeURIComponent(join(root, 'notes.txt'))}`,
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid path' })
  })
})
