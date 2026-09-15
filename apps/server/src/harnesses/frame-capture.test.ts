import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonlRpcTransport, type JsonRpcIncoming } from './jsonrpc.js'
import { deferred } from './transport-test-helpers.js'

const transports: JsonlRpcTransport[] = []
afterEach(async () => {
  await Promise.all(transports.splice(0).map((t) => t.close()))
})
function fixture(
  onIncoming?: (message: JsonRpcIncoming) => Promise<void> | void,
  maxHandlers = 4,
) {
  const stdin = new PassThrough(),
    stdout = new PassThrough()
  stdin.resume()
  const frames: Array<{ ordinal: number; source: string; released: boolean }> =
    []
  const seen: JsonRpcIncoming[] = []
  const transport = new JsonlRpcTransport({
    stdin,
    stdout,
    runtimeGeneration: 'frame-test',
    maxIncomingHandlers: maxHandlers,
    captureFrame(source) {
      const frame = { ordinal: frames.length + 1, source, released: false }
      frames.push(frame)
      return {
        context: frame,
        release() {
          expect(frame.released).toBe(false)
          frame.released = true
        },
      }
    },
    onIncoming(message) {
      seen.push(message)
      return onIncoming?.(message)
    },
  })
  transports.push(transport)
  return { stdout, transport, frames, seen }
}

describe('frame admission and original source ownership', () => {
  it('captures exact integer/exponent/null source before parsing and preserves split UTF-8 order', async () => {
    const f = fixture()
    const source =
      '{"jsonrpc":"2.0","id":0,"method":"question","params":{"max":18446744073709551615,"min":-9223372036854775808,"exp":1e+03,"value":null,"text":"é"}}'
    const bytes = Buffer.from(source + '\r\n')
    const split = bytes.indexOf(Buffer.from('é')) + 1
    f.stdout.write(bytes.subarray(0, split))
    expect(f.frames).toEqual([])
    f.stdout.write(bytes.subarray(split))
    expect(f.frames[0]!.source).toBe(source + '\r')
    const question = f.seen[0]!
    expect(question.ownership?.capture).toBe(f.frames[0])
    expect(f.frames[0]!.released).toBe(false)
    if (question.type !== 'request') throw Error('missing request')
    f.transport.dismiss(question)
    expect(f.frames[0]!.released).toBe(true)
    f.stdout.end('{"jsonrpc":"2.0","method":"final"}')
    await f.transport.done
    expect(f.frames[1]).toMatchObject({ ordinal: 2, released: true })
  })
  it.each([
    '{broken',
    '{"jsonrpc":"2.0","id":99,"result":null}',
    '{"jsonrpc":"2.0","id":null,"method":"invalid"}',
  ])('releases rejected or unowned frame %s', async (source) => {
    const f = fixture()
    f.stdout.write(source + '\n')
    expect(f.frames).toHaveLength(1)
    expect(f.frames[0]!.released).toBe(true)
  })
  it('retains active handler source through dismissal and close but releases queued source immediately', async () => {
    const held = deferred<void>()
    const f = fixture(() => held.promise, 1)
    f.stdout.write(
      '{"jsonrpc":"2.0","id":1,"method":"held"}\n{"jsonrpc":"2.0","id":2,"method":"queued"}\n',
    )
    expect(f.frames.map((f) => f.released)).toEqual([false, false])
    await f.transport.close()
    expect(f.frames.map((f) => f.released)).toEqual([false, true])
    held.resolve()
    await held.promise
    await Promise.resolve()
    expect(f.frames.map((f) => f.released)).toEqual([true, true])
  })
  it('releases both original and duplicate ID captures on protocol failure', async () => {
    const f = fixture()
    f.stdout.write(
      '{"jsonrpc":"2.0","id":1,"method":"first"}\n{"jsonrpc":"2.0","id":1,"method":"duplicate"}\n',
    )
    await f.transport.done
    expect(f.frames.map((f) => f.released)).toEqual([true, true])
  })
})
