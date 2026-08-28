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
