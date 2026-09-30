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
  return { shared, home }
}

describe('linkClaudeSharedConfig', () => {
  it('links shared entries that exist and skips missing ones', () => {
    const { shared, home } = fixture()
    linkClaudeSharedConfig(home, shared)
    expect(readlinkSync(join(home, 'skills'))).toBe(join(shared, 'skills'))
    expect(readlinkSync(join(home, 'settings.json'))).toBe(
      join(shared, 'settings.json'),
    )
    expect(existsSync(join(home, 'skills', 'lavish'))).toBe(true)
    expect(existsSync(join(home, 'agents'))).toBe(false)
  })

  it('is idempotent and repoints foreign links', () => {
    const { shared, home } = fixture()
    symlinkSync(join(shared, 'elsewhere'), join(home, 'skills'))
    linkClaudeSharedConfig(home, shared)
    linkClaudeSharedConfig(home, shared)
    expect(readlinkSync(join(home, 'skills'))).toBe(join(shared, 'skills'))
    expect(existsSync(join(home, '.forge-displaced'))).toBe(false)
  })

  it('moves a real entry aside instead of deleting it', () => {
    const { shared, home } = fixture()
    mkdirSync(join(home, 'skills', 'synced'), { recursive: true })
    writeFileSync(join(home, 'skills', 'synced', 'keep.md'), 'keep')
    linkClaudeSharedConfig(home, shared)
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
    const { shared, home } = fixture()
    writeFileSync(join(shared, '.credentials.json'), 'shared')
    writeFileSync(join(home, '.credentials.json'), 'private')
    linkClaudeSharedConfig(home, shared)
    expect(readFileSync(join(home, '.credentials.json'), 'utf8')).toBe(
      'private',
    )
  })
})
