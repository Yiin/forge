import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { JsonlRpcTransport } from './jsonl.js'

async function* chunks(values: string[]) {
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (const value of values) yield new TextEncoder().encode(value)
}

describe('JsonlRpcTransport', () => {
  it('keeps one decoder across fragmented and multiframe input', async () => {
    const seen: unknown[] = []
    const transport = new JsonlRpcTransport({
      stdin: new PassThrough(),
      stdout: chunks([
        '{"jsonrpc":"2.0","id":1,"result":{"text":"caf',
        'é"}}\n{"jsonrpc":"2.0","method":"note","params":{"n":1}}\n',
      ]),
      onIncoming: (message) => {
        seen.push(message)
      },
    })
    await expect(transport.request('hello')).resolves.toEqual({ text: 'café' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seen).toContainEqual({
      type: 'notification',
      method: 'note',
      params: { n: 1 },
    })
    await transport.close()
  })

  it('correlates concurrent requests and drains notifications', async () => {
    const stdin = new PassThrough()
    const writes: string[] = []
    stdin.on('data', (data) => writes.push(String(data)))
    const transport = new JsonlRpcTransport({
      stdin,
      stdout: chunks([
        '{"jsonrpc":"2.0","method":"tick","params":{}}\n',
        '{"jsonrpc":"2.0","id":2,"result":"two"}\n{"jsonrpc":"2.0","id":1,"result":"one"}\n',
      ]),
    })
    const first = transport.request('first')
    const second = transport.request('second')
    await expect(Promise.all([first, second])).resolves.toEqual(['one', 'two'])
    expect(writes.join('')).toContain('"method":"first"')
    await transport.close()
  })

  it('bounds frames and redacts secrets from RPC errors', async () => {
    const transport = new JsonlRpcTransport({
      stdin: new PassThrough(),
      stdout: chunks([
        '{"jsonrpc":"2.0","id":1,"error":{"message":"token-123 failed"}}\n',
      ]),
      secrets: ['token-123'],
      maxLineBytes: 100,
    })
    await expect(transport.request('fail')).rejects.toThrow('[REDACTED] failed')
    await transport.close()
    const oversized = new JsonlRpcTransport({
      stdin: new PassThrough(),
      stdout: (async function* () {
        await new Promise((resolve) => setTimeout(resolve, 10))
        yield new TextEncoder().encode(`{"x":"${'x'.repeat(101)}"}\n`)
      })(),
      maxLineBytes: 100,
    })
    await expect(oversized.request('never')).rejects.toThrow('exceeds limit')
    await oversized.close()
  })

  it('settles a cancelled request once', async () => {
    const controller = new AbortController()
    const transport = new JsonlRpcTransport({
      stdin: new PassThrough(),
      stdout: chunks([]),
    })
    const request = transport.request('slow', undefined, {
      signal: controller.signal,
    })
    controller.abort()
    await expect(request).rejects.toThrow('cancelled')
    await transport.close()
  })
})
