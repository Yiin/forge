import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { linkClaudeSharedConfig } from './claude-home.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'forge-claude-home-'))
  roots.push(root)
  const shared = join(root, 'shared')
  const home = join(root, 'home')
  mkdirSync(join(shared, 'skills', 'lavish'), { recursive: true })
  writeFileSync(join(shared, 'settings.json'), '{}')
  mkdirSync(home)
  return { shared, home, projects: join(root, 'projects') }
}

describe('linkClaudeSharedConfig', () => {
  it('links shared entries that exist and skips missing ones', () => {
    const { shared, home, projects } = fixture()
    linkClaudeSharedConfig(home, shared, projects)
    expect(readlinkSync(join(home, 'skills'))).toBe(join(shared, 'skills'))
    expect(readlinkSync(join(home, 'settings.json'))).toBe(
      join(shared, 'settings.json'),
    )
    expect(existsSync(join(home, 'skills', 'lavish'))).toBe(true)
    expect(existsSync(join(home, 'agents'))).toBe(false)
  })

  it('is idempotent and repoints foreign links', () => {
    const { shared, home, projects } = fixture()
    symlinkSync(join(shared, 'elsewhere'), join(home, 'skills'))
    linkClaudeSharedConfig(home, shared, projects)
    linkClaudeSharedConfig(home, shared, projects)
    expect(readlinkSync(join(home, 'skills'))).toBe(join(shared, 'skills'))
    expect(existsSync(join(home, '.forge-displaced'))).toBe(false)
  })

  it('moves a real entry aside instead of deleting it', () => {
    const { shared, home, projects } = fixture()
    mkdirSync(join(home, 'skills', 'synced'), { recursive: true })
    writeFileSync(join(home, 'skills', 'synced', 'keep.md'), 'keep')
    linkClaudeSharedConfig(home, shared, projects)
    expect(readlinkSync(join(home, 'skills'))).toBe(join(shared, 'skills'))
    const [moved] = readdirSync(join(home, '.forge-displaced'))
    expect(moved).toMatch(/^skills\.\d+$/)
    expect(
      readFileSync(
        join(home, '.forge-displaced', moved!, 'synced', 'keep.md'),
        'utf8',
      ),
    ).toBe('keep')
  })

  it('leaves private account state untouched', () => {
    const { shared, home, projects } = fixture()
    writeFileSync(join(shared, '.credentials.json'), 'shared')
    writeFileSync(join(home, '.credentials.json'), 'private')
    linkClaudeSharedConfig(home, shared, projects)
    expect(readFileSync(join(home, '.credentials.json'), 'utf8')).toBe(
      'private',
    )
  })

  it('shares one projects dir between account homes', () => {
    const { shared, home, projects } = fixture()
    const other = join(home, '..', 'other')
    mkdirSync(other)
    linkClaudeSharedConfig(home, shared, projects)
    linkClaudeSharedConfig(other, shared, projects)
    expect(readlinkSync(join(home, 'projects'))).toBe(projects)
    expect(readlinkSync(join(other, 'projects'))).toBe(projects)
    mkdirSync(join(home, 'projects', '-repo'))
    writeFileSync(join(home, 'projects', '-repo', 'a.jsonl'), 'a')
    expect(
      readFileSync(join(other, 'projects', '-repo', 'a.jsonl'), 'utf8'),
    ).toBe('a')
  })

  it('merges a real projects dir into the shared one without data loss', () => {
    const { shared, home, projects } = fixture()
    mkdirSync(join(projects, '-repo'), { recursive: true })
    writeFileSync(join(projects, '-repo', 'same.jsonl'), 'shared')
    mkdirSync(join(home, 'projects', '-repo', 'sub'), { recursive: true })
    writeFileSync(join(home, 'projects', '-repo', 'same.jsonl'), 'private')
    writeFileSync(join(home, 'projects', '-repo', 'own.jsonl'), 'own')
    writeFileSync(join(home, 'projects', '-repo', 'sub', 'agent.jsonl'), 'sub')
    linkClaudeSharedConfig(home, shared, projects)
    linkClaudeSharedConfig(home, shared, projects)
    expect(readlinkSync(join(home, 'projects'))).toBe(projects)
    const repo = join(projects, '-repo')
    expect(readdirSync(repo).sort()).toEqual([
      'own.jsonl',
      'same.jsonl',
      'same.jsonl.home',
      'sub',
    ])
    expect(readFileSync(join(repo, 'same.jsonl'), 'utf8')).toBe('shared')
    expect(readFileSync(join(repo, 'same.jsonl.home'), 'utf8')).toBe('private')
    expect(readFileSync(join(repo, 'own.jsonl'), 'utf8')).toBe('own')
    expect(readFileSync(join(repo, 'sub', 'agent.jsonl'), 'utf8')).toBe('sub')
    expect(existsSync(join(home, '.forge-displaced'))).toBe(false)
  })
})
