import { describe, expect, it } from 'vitest'
import { ForgeApi } from './api'

const api = (response: Response) =>
  new ForgeApi({
    baseUrl: 'http://forge.test',
    fetch: (() => Promise.resolve(response)) as typeof globalThis.fetch,
  })

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('ForgeApi error reporting', () => {
  it('includes the server error body in thrown errors', async () => {
    const client = api(jsonResponse(400, { error: 'Project not found' }))
    await expect(client.listSessions()).rejects.toThrow(
      'Forge API request failed (400): Project not found',
    )
  })

  it('falls back to the bare status when the body is not JSON', async () => {
    const client = api(new Response('nope', { status: 500 }))
    await expect(client.listSessions()).rejects.toThrow(
      'Forge API request failed (500)',
    )
  })
})

it('keys a prompt resend to the same request so the server drops a copy', async () => {
  const keys: string[] = []
  const client = new ForgeApi({
    baseUrl: 'http://forge.test',
    fetch: (async (_url, init) => {
      keys.push(new Headers(init?.headers).get('Idempotency-Key')!)
      return jsonResponse(200, { ok: true })
    }) as typeof fetch,
  })
  const prompt = { sessionId: 'session-1', text: 'hi' }
  const id = 'client_0123456789abcdef0123456789abcdef'
  await client.prompt(prompt, id)
  await client.prompt(prompt, id)
  await client.prompt(prompt)
  expect(keys[0]).toBe(id)
  expect(keys[1]).toBe(id)
  expect(keys[2]).not.toBe(id)
})

it('uses session Git routes for projectless targets and keeps project routes for project consumers', async () => {
  const urls: string[] = []
  const client = new ForgeApi({
    baseUrl: 'http://forge.test',
    fetch: (async (url) => {
      urls.push(String(url))
      return jsonResponse(200, {})
    }) as typeof fetch,
  })
  await client.gitStatus('', '/tmp', 'session/id')
  await client.gitBranches('', { sessionId: 'session/id' })
  await client.gitDiff('', { sessionId: 'session/id' })
  await client.gitHistory('', { sessionId: 'session/id' })
  expect(urls.map((url) => new URL(url).pathname)).toEqual(
    ['status', 'branches', 'diff', 'history'].map(
      (method) => `/api/sessions/session%2Fid/git/${method}`,
    ),
  )
  await client.gitDiff('project/id')
  expect(new URL(urls.at(-1)!).pathname).toBe(
    '/api/projects/project%2Fid/git/diff',
  )
})
