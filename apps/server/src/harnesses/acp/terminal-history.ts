import { randomUUID } from 'node:crypto'
import type { AcpResourceHost } from './limits.js'

const maxBytes = 4 * 1024 * 1024

/** One public handle retains terminal identities across transport replacements. */
export function createAcpTerminalHistory(
  host: AcpResourceHost,
  instanceId: string,
  runtimeGeneration: string,
) {
  if (!instanceId || !runtimeGeneration)
    throw Error('Invalid ACP terminal history authority')
  const release = host.reserve(instanceId, 'retained', maxBytes)
  const entries = new Map<string, { scope: string; retired: boolean }>()
  let bytes = 0,
    closed = false
  return {
    assert(
      expectedHost: AcpResourceHost,
      expectedInstance: string,
      expectedGeneration: string,
    ) {
      if (
        closed ||
        expectedHost !== host ||
        expectedInstance !== instanceId ||
        expectedGeneration !== runtimeGeneration
      )
        throw Error('ACP terminal history owner mismatch')
    },
    admit(scope: string, metadataBytes: number) {
      if (closed) throw Error('ACP terminal history is closed')
      if (
        !Number.isSafeInteger(metadataBytes) ||
        metadataBytes < 4 * Buffer.byteLength(scope) + 256
      )
        throw Error('Invalid ACP terminal history charge')
      if (entries.size >= 4096 || bytes + metadataBytes > maxBytes)
        throw Error('ACP terminal metadata capacity')
      const id = randomUUID()
      entries.set(id, { scope, retired: false })
      bytes += metadataBytes
      return id
    },
    retire(id: string, scope: string) {
      const entry = entries.get(id)
      if (closed || !entry || entry.scope !== scope)
        throw Error('ACP terminal retirement owner mismatch')
      entry.retired = true
    },
    isRetired(id: string, scope: string) {
      const entry = entries.get(id)
      return !closed && entry?.retired === true && entry.scope === scope
    },
    close() {
      if (closed) return
      if ([...entries.values()].some((entry) => !entry.retired))
        throw Error('ACP terminal history still owns active terminals')
      closed = true
      entries.clear()
      release()
    },
  }
}

export type AcpTerminalHistory = ReturnType<typeof createAcpTerminalHistory>
