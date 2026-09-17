import { createServer } from 'node:net'
import { expect, it } from 'vitest'
import { PreviewManager } from './manager.js'
import type { WorkspaceTargets } from '../workspace/target.js'
it('checks the original loopback port and joins probe sockets before shutdown', async () => {
  const server = createServer((socket) => socket.resume())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('No listener')
  const manager = new PreviewManager(
    {
      resolve: async () => ({ workspaceId: 'w', workspaceRevision: 1 }),
    } as unknown as WorkspaceTargets,
    'http://preview.test',
  )
  try {
    const target = await manager.register({
      sessionId: 's',
      origin: `http://127.0.0.1:${address.port}`,
    })
    expect(await manager.reachable(target.id)).toBe(true)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    expect(await manager.reachable(target.id)).toBe(false)
    const leases = Array.from({ length: 64 }, () => manager.acquire(target.id))
    await expect(manager.reachable(target.id)).rejects.toThrow(
      'connection limit',
    )
    leases.forEach((lease) => lease.release())
    await manager.close()
    await expect(manager.reachable(target.id)).rejects.toThrow('not found')
  } finally {
    await manager.close()
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('settles an admitted probe before manager shutdown returns', async () => {
  const server = createServer((socket) => socket.resume())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('No listener')
  const manager = new PreviewManager(
    {
      resolve: async () => ({ workspaceId: 'w', workspaceRevision: 1 }),
    } as unknown as WorkspaceTargets,
    'http://preview.test',
  )
  try {
    const target = await manager.register({
      sessionId: 's',
      origin: `http://127.0.0.1:${address.port}`,
    })
    const probe = manager.reachable(target.id)
    await manager.close()
    expect(await probe).toBe(false)
  } finally {
    await manager.close()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
