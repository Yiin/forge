import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listSkills } from './registry.js'

const cleanups: string[] = []
afterEach(async () => {
  await Promise.all(
    cleanups
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

async function root() {
  const path = await mkdtemp(join(tmpdir(), 'forge-skills-'))
  cleanups.push(path)
  return path
}

async function skill(rootPath: string, name: string, frontmatter: string) {
  const directory = join(rootPath, name)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'SKILL.md'),
    `---\n${frontmatter}\n---\n# Skill\n`,
  )
}

describe('skill registry', () => {
  it('uses root precedence, validates frontmatter, and skips missing roots', async () => {
    const workspace = await root()
    const claude = join(workspace, '.claude', 'skills')
    const agents = join(workspace, '.agents', 'skills')
    const global = join(workspace, 'global')
    await skill(claude, 'same', 'name: same\ndescription: Claude')
    await skill(agents, 'same', 'name: same\ndescription: Agents')
    await skill(agents, 'fallback', 'description: Directory name')
    await skill(agents, 'bad', 'name: Bad Name\ndescription: Invalid')
    await skill(agents, 'broken', 'name: broken\ndescription: Missing close')
    await writeFile(join(agents, 'broken', 'SKILL.md'), '---\nname: broken\n')
    await skill(global, 'global', 'name: global\ndescription: Global')

    const skills = await listSkills(workspace, global)
    expect(skills).toEqual([
      { name: 'same', description: 'Claude' },
      { name: 'fallback', description: 'Directory name' },
      { name: 'global', description: 'Global' },
    ])
  })

  it('refreshes a root when its directory mtime changes', async () => {
    const workspace = await root()
    const agents = join(workspace, '.agents', 'skills')
    await skill(agents, 'one', 'name: one\ndescription: One')
    expect(
      (await listSkills(workspace, join(workspace, 'global'))).map(
        (x) => x.name,
      ),
    ).toEqual(['one'])
    await skill(agents, 'two', 'name: two\ndescription: Two')
    await utimes(agents, new Date(), new Date(Date.now() + 2000))
    expect(
      (await listSkills(workspace, join(workspace, 'global'))).map(
        (x) => x.name,
      ),
    ).toEqual(['one', 'two'])
  })
})
