import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { readAccountIdentity } from './identity.js'

const roots: string[] = []
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
)
function home() {
  const root = mkdtempSync(join(tmpdir(), 'forge-identity-'))
  roots.push(root)
  return root
}

describe('readAccountIdentity', () => {
  it('reads Claude profile and OAuth plan without exposing credentials', () => {
    const root = home()
    writeFileSync(
      join(root, '.claude.json'),
      JSON.stringify({
        oauthAccount: {
          emailAddress: 'person@example.com',
          displayName: 'Person',
          accountUuid: 'uuid',
        },
      }),
    )
    writeFileSync(
      join(root, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'secret-token',
          subscriptionType: 'max',
        },
      }),
    )
    expect(readAccountIdentity('claude', root)).toEqual({
      status: 'authenticated',
      email: 'person@example.com',
      displayName: 'Person',
      accountUuid: 'uuid',
      plan: 'max',
    })
  })

  it('decodes Codex JWT claims locally and reads provider sets', () => {
    const root = home()
    const payload = Buffer.from(
      JSON.stringify({
        email: 'codex@example.com',
        name: 'Codex User',
        'https://api.openai.com/auth': {
          chatgpt_plan_type: 'pro',
          chatgpt_account_id: 'acct',
        },
      }),
    ).toString('base64url')
    writeFileSync(
      join(root, 'auth.json'),
      JSON.stringify({ tokens: { id_token: `header.${payload}.signature` } }),
    )
    expect(readAccountIdentity('codex', root)).toMatchObject({
      email: 'codex@example.com',
      plan: 'pro',
      accountUuid: 'acct',
    })
    const opencode = join(root, 'opencode')
    mkdirSync(opencode)
    writeFileSync(
      join(opencode, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api' }, xai: { type: 'oauth' } }),
    )
    expect(readAccountIdentity('opencode', root)).toMatchObject({
      status: 'authenticated',
      providers: ['anthropic', 'xai'],
      label: 'anthropic, xai',
    })
  })

  it('reports safe unknown states for malformed or unsupported homes', () => {
    const root = home()
    writeFileSync(join(root, '.claude.json'), '{')
    expect(readAccountIdentity('claude', root).status).toBe('unauthenticated')
    expect(readAccountIdentity('grok', root)).toEqual({ status: 'unknown' })
    expect(readAccountIdentity('pi', root).status).toBe('unknown')
  })
})
