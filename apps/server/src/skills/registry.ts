import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Dirent } from 'node:fs'
import type { Skill } from '@forge/protocol/skills'

type CacheEntry = { mtimeMs: number; skills: Skill[] }
const cache = new Map<string, CacheEntry>()
const validName = /^[a-z0-9][a-z0-9-]*$/

function scalar(value: string) {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  )
    return trimmed.slice(1, -1)
  return trimmed
}

async function readSkill(directory: string): Promise<Skill | undefined> {
  let source: string
  try {
    source = await readFile(join(directory, 'SKILL.md'), 'utf8')
  } catch {
    return undefined
  }
  const lines = source.split(/\r?\n/)
  if (lines[0] !== '---') return undefined
  const end = lines.indexOf('---', 1)
  if (end < 0) return undefined
  let name: string | undefined
  let description = ''
  for (const line of lines.slice(1, end)) {
    const match = /^(name|description):\s*(.*)$/.exec(line)
    if (!match) continue
    if (match[1] === 'name') name = scalar(match[2] ?? '')
    else description = scalar(match[2] ?? '')
  }
  const resolvedName = name || directory.split('/').pop() || ''
  if (!validName.test(resolvedName)) return undefined
  return { name: resolvedName, description }
}

async function scanRoot(root: string): Promise<Skill[]> {
  let rootMtime: number
  let entries: Dirent<string>[]
  try {
    const info = await stat(root)
    if (!info.isDirectory()) return []
    rootMtime = info.mtimeMs
    const cached = cache.get(root)
    if (cached?.mtimeMs === rootMtime) return cached.skills
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    cache.delete(root)
    return []
  }
  const skills = (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => readSkill(join(root, entry.name))),
    )
  ).filter((skill): skill is Skill => skill !== undefined)
  cache.set(root, { mtimeMs: rootMtime, skills })
  return skills
}

export function skillRoots(
  workspaceRoot: string,
  globalRoot = join(homedir(), '.agents', 'skills'),
) {
  return [
    join(workspaceRoot, '.claude', 'skills'),
    join(workspaceRoot, '.agents', 'skills'),
    globalRoot,
  ]
}

export async function listSkills(
  workspaceRoot: string,
  globalRoot = join(homedir(), '.agents', 'skills'),
): Promise<Skill[]> {
  const found = new Map<string, Skill>()
  for (const root of skillRoots(workspaceRoot, globalRoot)) {
    for (const skill of await scanRoot(root)) {
      if (!found.has(skill.name)) found.set(skill.name, skill)
    }
  }
  return [...found.values()]
}
