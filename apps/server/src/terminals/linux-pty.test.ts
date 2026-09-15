import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { resolveTerminalLimits } from './limits.js'

const nativeState = {
  socketClosed: false,
}

vi.mock('node-pty', () => {
  const socket = new EventEmitter() as EventEmitter & {
    _handle: { fd: number } | null
    closed: boolean
    destroyed: boolean
    destroy: () => void
  }
  socket._handle = { fd: 42 }
  socket.closed = false
  socket.destroyed = false
  socket.destroy = () => {
    socket.closed = true
    socket.destroyed = true
    socket._handle = null
    setImmediate(() => {
      nativeState.socketClosed = true
      socket.emit('close')
    })
  }

  const api = {
    forgeOwnedApiVersion: 1,
    spawnOwnedLinuxV1: () => ({
      token: {},
      pty: { fd: 42, _socket: socket },
      ready: Promise.resolve({
        pid: 123,
        startTime: 1,
        pidfd: 2,
        pgid: 123,
      }),
    }),
    ownedStateV1: () => ({
      phase: 'running',
      socketClosed: nativeState.socketClosed,
      waitWorkerSettled: true,
    }),
    inspectOwnedV1: async () => ({
      status: 'complete',
      members: [],
    }),
    signalOwnedV1: async () => undefined,
    reapOwnedV1: async () =>
      nativeState.socketClosed ? { status: 'complete' } : { status: 'unknown' },
    abortBeforeReleaseV1: () => undefined,
  }
  return {
    ...api,
    spawnOwnedLinuxV1: api.spawnOwnedLinuxV1,
    ownedLinuxV1: api,
  }
})

import { LinuxPty } from './linux-pty.js'

describe('LinuxPty cleanup', () => {
  it('waits for the close event before reaping an already-destroyed socket', async () => {
    nativeState.socketClosed = false
    const terminal = new LinuxPty(
      '/bin/sh',
      [],
      process.cwd(),
      {},
      80,
      24,
      resolveTerminalLimits({
        cleanupDeadlineMs: 1000,
        termGraceMs: 1,
        scanRounds: 1,
        scanEntries: 8,
        scanBytes: 4096,
        statBytes: 4096,
        members: 8,
        inspections: 1,
        startupDeadlineMs: 1000,
      }),
      () => {},
    )

    const socket = terminal.socket!
    socket.closed = true
    socket._handle = null
    setImmediate(() => {
      nativeState.socketClosed = true
      socket.emit('close')
    })

    const result = await terminal.cleanup()

    expect(result).toBe(true)
    expect(nativeState.socketClosed).toBe(true)
  })
})
