import { afterEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { once } from 'node:events'
import { connect, type Socket } from 'node:net'
import type { IncomingMessage, Server } from 'node:http'
import { WebSocket } from 'ws'
import { WebSocketUpgrades } from './ws-upgrade.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function fixture(maxOpening = 2, deadlineMs = 100) {
  const app = new Hono(),
    upgrades = new WebSocketUpgrades(app, maxOpening, deadlineMs)
  app.onError((_error, c) => c.text('Rejected', 500))
  const server = serve({
    fetch: app.fetch,
    hostname: '127.0.0.1',
    port: 0,
  }) as Server
  upgrades.install(server)
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  const clients = new Set<Socket | WebSocket>()
  const releases: Array<() => void> = []
  cleanup.push(async () => {
    for (const release of releases) release()
    await Promise.all(
      [...clients].map(async (client) => {
        if (client instanceof WebSocket) {
          if (client.readyState === WebSocket.CLOSED) return
          const closed = once(client, 'close')
          client.terminate()
          await closed
        } else if (!client.closed) {
          const closed = once(client, 'close')
          client.destroy()
          await closed
        }
      }),
    )
    try {
      await vi.waitFor(() => expect(upgrades.resourceState().openings).toBe(0))
      expect(await upgrades.close()).toBe(true)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
    expect(upgrades.resourceState()).toEqual({
      openings: 0,
      sessionSockets: 0,
      terminalSockets: 0,
    })
  })
  const raw = async (path = '/ws', extra = '') => {
    const socket = connect(port, '127.0.0.1')
    clients.add(socket)
    socket.on('error', () => {})
    const chunks: Buffer[] = []
    socket.on('data', (chunk) => chunks.push(chunk))
    await once(socket, 'connect')
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${extra}\r\n`,
    )
    return { socket, text: () => Buffer.concat(chunks).toString() }
  }
  const websocket = (path = '/ws') => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`)
    clients.add(socket)
    socket.on('error', () => {})
    return socket
  }
  return { app, server, upgrades, raw, websocket, releases }
}

describe('one Node WebSocket upgrade dispatcher', () => {
  it('keeps a timed-out opening charged until its original route settles', async () => {
    const { app, upgrades, raw, releases } = await fixture(1, 20)
    const entered = deferred(),
      held = deferred(),
      released = vi.fn()
    releases.push(held.resolve)
    app.get('/ws', async (c) => {
      upgrades.opening(
        (c.env as { incoming: IncomingMessage }).incoming,
        released,
      )
      entered.resolve()
      await held.promise
      return upgrades.upgradeWebSocket(c, {})
    })
    const first = await raw()
    await entered.promise
    await once(first.socket, 'close')
    await vi.waitFor(() => expect(released).toHaveBeenCalledTimes(1))
    expect(upgrades.resourceState().openings).toBe(1)
    const refused = await raw()
    await once(refused.socket, 'close')
    expect(refused.text()).toContain('503 Rejected')
    expect(upgrades.resourceState().openings).toBe(1)
    held.resolve()
    await vi.waitFor(() => expect(upgrades.resourceState().openings).toBe(0))
  })

  it('rejects malformed handshakes before route registration', async () => {
    const { app, upgrades, raw } = await fixture()
    const released = vi.fn(),
      observed: string[][] = []
    app.get('/ws', (c) => {
      const incoming = (c.env as { incoming: IncomingMessage }).incoming
      observed.push(incoming.rawHeaders)
      upgrades.opening(incoming, released)
      return upgrades.upgradeWebSocket(c, {})
    })
    const client = await raw(
      '/ws',
      'Sec-WebSocket-Key: invalid\r\nOrigin: http://a\r\nOrigin: http://b\r\n',
    )
    await once(client.socket, 'close')
    await vi.waitFor(() => expect(upgrades.resourceState().openings).toBe(0))
    expect(released).not.toHaveBeenCalled()
    expect(observed).toHaveLength(0)
    expect(client.text()).toContain('403')
  })

  it('dispatches the existing session socket and bounded terminal socket through one listener', async () => {
    const { app, server, upgrades, websocket, raw } = await fixture()
    const terminalPath = '/api/sessions/session/terminals/terminal/events'
    app.get('/ws', (c) =>
      upgrades.upgradeWebSocket(c, {
        onOpen: (_event, ws) => ws.send('session'),
        onMessage: (event, ws) => ws.send(event.data as string),
      }),
    )
    app.get(terminalPath, (c) =>
      upgrades.upgradeWebSocket(c, {
        onOpen: (_event, ws) => ws.send('terminal'),
      }),
    )
    const session = websocket(),
      terminal = websocket(terminalPath)
    expect(String((await once(session, 'message'))[0])).toBe('session')
    expect(String((await once(terminal, 'message'))[0])).toBe('terminal')
    expect(server.listenerCount('upgrade')).toBe(1)
    expect(upgrades.resourceState()).toEqual({
      openings: 0,
      sessionSockets: 1,
      terminalSockets: 1,
    })
    session.send('x'.repeat(2048))
    expect(String((await once(session, 'message'))[0])).toHaveLength(2048)
    terminal.send('x'.repeat(1025))
    await once(terminal, 'close')
    expect(session.readyState).toBe(WebSocket.OPEN)
    const unknown = await raw('/unknown')
    await once(unknown.socket, 'close')
    expect(unknown.text()).toContain('404 Rejected')
    expect(() => upgrades.install(server)).toThrow(
      'Only one Forge WebSocket upgrade listener is allowed',
    )
  })

  it('rejects duplicate route registration without losing its opening callback', async () => {
    const { app, upgrades, raw } = await fixture()
    const released = vi.fn()
    app.get('/ws', async (c) => {
      upgrades.opening(
        (c.env as { incoming: IncomingMessage }).incoming,
        released,
      )
      await upgrades.upgradeWebSocket(c, {})
      return upgrades.upgradeWebSocket(c, {})
    })
    const client = await raw()
    await once(client.socket, 'close')
    await vi.waitFor(() => expect(upgrades.resourceState().openings).toBe(0))
    expect(released).toHaveBeenCalledTimes(1)
    expect(upgrades.resourceState().sessionSockets).toBe(0)
  })
})
