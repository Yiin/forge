import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { accountAuthenticated } from '../src/accounts/store.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('account credentials', () => {
  it('recognizes the Kimi Code credential path', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-kimi-'))
    roots.push(home)
    mkdirSync(join(home, 'credentials'))
    writeFileSync(join(home, 'credentials', 'kimi-code.json'), '{}')

    expect(accountAuthenticated('kimi', home)).toBe(true)
  })
})
