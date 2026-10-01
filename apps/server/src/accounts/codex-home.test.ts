import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexSharedRoot, linkCodexSessions } from './codex-home.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'forge-codex-home-'))
  roots.push(root)
  const a = join(root, 'acct_a')
  const b = join(root, 'acct_b')
  mkdirSync(a)
  mkdirSync(b)
  return { shared: join(root, 'shared'), a, b }
}

const day = join('2026', '10', '01')

describe('linkCodexSessions', () => {
  it('shares rollout dirs between account homes and keeps auth private', () => {
    const { shared, a, b } = fixture()
    writeFileSync(join(a, 'auth.json'), 'a')
    writeFileSync(join(b, 'auth.json'), 'b')
    linkCodexSessions(a, shared)
    linkCodexSessions(b, shared)
    for (const name of ['sessions', 'archived_sessions']) {
      expect(readlinkSync(join(a, name))).toBe(join(shared, name))
      expect(readlinkSync(join(b, name))).toBe(join(shared, name))
    }
    mkdirSync(join(a, 'sessions', day), { recursive: true })
    writeFileSync(join(a, 'sessions', day, 'rollout-x.jsonl'), 'x')
    expect(
      readFileSync(join(b, 'sessions', day, 'rollout-x.jsonl'), 'utf8'),
    ).toBe('x')
    expect(readFileSync(join(a, 'auth.json'), 'utf8')).toBe('a')
    expect(readFileSync(join(b, 'auth.json'), 'utf8')).toBe('b')
  })

  it('replaces real rollout dirs with links and is idempotent', () => {
    const { shared, a } = fixture()
    mkdirSync(join(a, 'sessions', day), { recursive: true })
    writeFileSync(join(a, 'archived_sessions'), 'old')
    linkCodexSessions(a, shared)
    linkCodexSessions(a, shared)
    for (const name of ['sessions', 'archived_sessions'])
      expect(readlinkSync(join(a, name))).toBe(join(shared, name))
    expect(readdirSync(join(shared, 'sessions'))).toEqual([])
  })

  it('lives under the Forge accounts dir, never ~/.codex', () => {
    const previous = process.env.FORGE_ACCOUNTS_DIR
    process.env.FORGE_ACCOUNTS_DIR = '/tmp/forge-accounts-test'
    try {
      expect(codexSharedRoot()).toBe('/tmp/forge-accounts-test/.shared/codex')
    } finally {
      if (previous === undefined) delete process.env.FORGE_ACCOUNTS_DIR
      else process.env.FORGE_ACCOUNTS_DIR = previous
    }
  })
})
