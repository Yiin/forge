import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  accountAuthenticated,
  clearAccountCredentials,
} from '../src/accounts/store.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('account credentials', () => {
  it('recognizes the Kimi Code credential path', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-kimi-'))
    roots.push(home)
    mkdirSync(join(home, 'credentials'))
    writeFileSync(join(home, 'credentials', 'kimi-code.json'), '{}')

    expect(accountAuthenticated('kimi', home)).toBe(true)
  })

  it('recognizes and clears the Grok auth file', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-grok-'))
    const home = join(root, 'account')
    mkdirSync(home)
    process.env.FORGE_ACCOUNTS_DIR = root
    roots.push(root)
    expect(accountAuthenticated('grok', home)).toBe(false)
    writeFileSync(join(home, 'auth.json'), '{}')
    expect(accountAuthenticated('grok', home)).toBe(true)
    clearAccountCredentials('grok', home)
    expect(accountAuthenticated('grok', home)).toBe(false)
  })
})
