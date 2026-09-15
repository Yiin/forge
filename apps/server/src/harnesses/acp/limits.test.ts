import { describe, expect, it } from 'vitest'
import { AcpResourceHost } from './limits.js'

describe('ACP server resource host', () => {
  it('shares instance and process limits across replacement callers', () => {
    const host = new AcpResourceHost({ commits: [1, 2] })
    const old = host.reserve('provider', 'commits')
    expect(() => host.reserve('provider', 'commits')).toThrow('limit')
    const other = host.reserve('other-provider', 'commits')
    expect(() => host.reserve('third-provider', 'commits')).toThrow('limit')
    old()
    old()
    const replacement = host.reserve('provider', 'commits')
    replacement()
    other()
    host.reserve('third-provider', 'commits')()
  })
  it('rolls back provisional transport bytes when callback capacity is exhausted', () => {
    const host = new AcpResourceHost({ writes: [1, 1], retained: [10, 10] })
    const transport = host.transport('provider')
    const first = transport.reserve('write', 5)
    expect(() => transport.reserve('write', 5)).toThrow('limit')
    const remaining = host.reserve('provider', 'retained', 5)
    remaining()
    first()
    host.reserve('provider', 'retained', 10)()
  })
  it('captures limit overrides and permits only reduced positive bounds', () => {
    const commits: [number, number] = [1, 1]
    const host = new AcpResourceHost({ commits })
    commits[0] = commits[1] = 99
    const held = host.reserve('provider', 'commits')
    expect(() => host.reserve('other', 'commits')).toThrow('limit')
    held()
    expect(() => new AcpResourceHost({ commits: [9, 33] })).toThrow('limit')
    expect(() => host.reserve('provider', 'retained', -1)).toThrow('charge')
  })
})
