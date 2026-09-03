import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { skillRoutes } from './skills.js'

const cleanups: string[] = []
afterEach(async () => {
  await Promise.all(
    cleanups
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('skill routes', () => {
  it('lists skills for projects and sessions, and returns 404 for missing rows', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'forge-skill-route-'))
    cleanups.push(workspace)
    const skillDir = join(workspace, '.agents', 'skills', 'beads')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: beads\ndescription: Track work\n---\n',
    )
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL);
    `)
    db.prepare('INSERT INTO projects VALUES (?, ?)').run('project', workspace)
    db.prepare('INSERT INTO sessions VALUES (?, ?)').run('session', workspace)
    const app = skillRoutes(db, join(workspace, 'missing-global-root'))
    expect(
      await (await app.request('/api/projects/project/skills')).json(),
    ).toEqual({
      skills: [{ name: 'beads', description: 'Track work' }],
    })
    expect(
      await (await app.request('/api/sessions/session/skills')).json(),
    ).toEqual({
      skills: [{ name: 'beads', description: 'Track work' }],
    })
    expect((await app.request('/api/projects/missing/skills')).status).toBe(404)
    expect((await app.request('/api/sessions/missing/skills')).status).toBe(404)
  })
})
