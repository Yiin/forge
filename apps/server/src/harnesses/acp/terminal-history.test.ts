import { describe, expect, test } from 'vitest'
import { createAcpTerminalHistory } from './terminal-history.js'
import { AcpResourceHost } from './limits.js'

describe('public ACP terminal identity history', () => {
  test('retired IDs and cumulative capacity survive repeated transport attachments', () => {
    const host = new AcpResourceHost()
    const history = createAcpTerminalHistory(host, 'instance', 'public')
    const ids = new Set<string>()
    for (let transport = 0; transport < 4; transport++) {
      history.assert(host, 'instance', 'public')
      for (let index = 0; index < 1024; index++) {
        const id = history.admit('scope', 1024)
        ids.add(id)
        history.retire(id, 'scope')
      }
    }
    expect(ids.size).toBe(4096)
    history.assert(host, 'instance', 'public')
    expect(() => history.admit('scope', 1024)).toThrow('capacity')
    for (const id of ids) {
      expect(history.isRetired(id, 'scope')).toBe(true)
      expect(history.isRetired(id, 'foreign')).toBe(false)
    }
    history.close()
    host.reserve('instance', 'retained', 128 * 1024 * 1024)()
  })

  test('an active terminal prevents history cleanup and keeps its original allocation', () => {
    const host = new AcpResourceHost()
    const history = createAcpTerminalHistory(host, 'instance', 'public')
    const id = history.admit('scope', 1024)
    expect(() => history.close()).toThrow('active terminals')
    expect(() =>
      host.reserve('instance', 'retained', 128 * 1024 * 1024),
    ).toThrow('limit')
    expect(() => history.retire(id, 'foreign')).toThrow('owner mismatch')
    history.retire(id, 'scope')
    history.close()
    history.close()
    expect(() => history.admit('scope', 1024)).toThrow('closed')
    host.reserve('instance', 'retained', 128 * 1024 * 1024)()
  })

  test('metadata capacity cannot reset while another transport uses the same public history', () => {
    const host = new AcpResourceHost()
    const history = createAcpTerminalHistory(host, 'instance', 'public')
    for (let index = 0; index < 128; index++) {
      const id = history.admit('scope', 32768)
      history.retire(id, 'scope')
    }
    history.assert(host, 'instance', 'public')
    expect(() => history.admit('scope', 1024)).toThrow('capacity')
    expect(() => history.assert(host, 'instance', 'foreign')).toThrow(
      'owner mismatch',
    )
    expect(() =>
      history.assert(new AcpResourceHost(), 'instance', 'public'),
    ).toThrow('owner mismatch')
    history.close()
  })
})
