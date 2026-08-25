import { afterEach, describe, expect, it } from 'vitest'
import { startServer } from '../src/index.js'

const servers: ReturnType<typeof startServer>[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

describe('health endpoint', () => {
  it('answers on an ephemeral port', async () => {
    const server = startServer(0)
    servers.push(server)
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('server did not expose a TCP address')

    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, version: '0.1.0' })
  })
})
