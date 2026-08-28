import { describe, expect, it } from 'vitest'
import { errorMessage } from './error-message.js'

describe('errorMessage', () => {
  it('uses the message of Error instances', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
  })

  it('serializes plain-object rejections such as ACP JSON-RPC errors', () => {
    const rpcError = {
      code: -32603,
      message: 'Internal error',
      data: { details: 'Method not implemented.' },
    }
    expect(errorMessage(rpcError)).toBe(JSON.stringify(rpcError))
  })

  it('passes strings through', () => {
    expect(errorMessage('plain')).toBe('plain')
  })

  it('falls back to String for circular objects', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(errorMessage(circular)).toBe('[object Object]')
  })
})
