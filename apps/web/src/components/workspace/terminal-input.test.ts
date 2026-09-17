import { expect, it, vi } from 'vitest'
import { terminalInputQueue } from './terminal-input'
const written = (bytes: number) =>
  new Response(
    JSON.stringify({
      status: 'written',
      requestedBytes: bytes,
      writtenBytes: bytes,
    }),
  )

it('encodes Unicode and control bytes as canonical base64 in original input order', async () => {
  let release!: (value: Response) => void
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    .mockResolvedValue(written(3))
  const report = vi.fn()
  const queue = terminalInputQueue('/terminal', report, fetcher)
  queue.input('\u0003é')
  queue.input('\u001b[A')
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(JSON.parse(fetcher.mock.calls[0][1].body).data).toBe(
    Buffer.from('\u0003é').toString('base64'),
  )
  release(written(3))
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
  expect(JSON.parse(fetcher.mock.calls[1][1].body).data).toBe('G1tB')
  expect(report).not.toHaveBeenCalled()
  queue.close()
})

it('bounds queued bytes and rejects oversized paste without sending a prefix', async () => {
  let release!: (value: Response) => void
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve
      }),
  )
  const report = vi.fn()
  const queue = terminalInputQueue('/terminal', report, fetcher)
  expect(queue.input('x'.repeat(65537))).toBe(false)
  expect(fetcher).not.toHaveBeenCalled()
  expect(queue.input('x'.repeat(65536))).toBe(true)
  expect(queue.input('y')).toBe(false)
  expect(fetcher).toHaveBeenCalledTimes(1)
  queue.close()
  release(written(65536))
})

it('does not send queued input or retry a partial original write', async () => {
  const report = vi.fn()
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          status: 'write_failed',
          requestedBytes: 2,
          writtenBytes: 1,
        }),
      ),
  )
  const queue = terminalInputQueue('/terminal', report, fetcher)
  queue.input('ab')
  queue.input('cd')
  await vi.waitFor(() => expect(report).toHaveBeenCalledOnce())
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(queue.input('ef')).toBe(false)
})

it('aborts only its original request on disposal and drops queued work', async () => {
  let release!: (value: Response) => void
  const fetcher = vi.fn().mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const report = vi.fn()
  const queue = terminalInputQueue('/terminal', report, fetcher)
  queue.input('a')
  queue.input('b')
  queue.close()
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true)
  release(written(1))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(report).not.toHaveBeenCalled()
})

it('keeps the latest resize while the original input fills the bounded queue', async () => {
  let release!: (response: Response) => void
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    )
    .mockImplementation(async (url: string) =>
      url.endsWith('/input') ? written(1) : new Response('{}'),
    )
  const report = vi.fn(),
    queue = terminalInputQueue('/terminal', report, fetcher)
  for (let index = 0; index < 64; index++) expect(queue.input('x')).toBe(true)
  expect(queue.input('y')).toBe(false)
  expect(queue.resize(80, 24)).toBe(true)
  expect(queue.resize(120, 40)).toBe(true)
  expect(fetcher).toHaveBeenCalledTimes(1)
  release(written(1))
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(65))
  expect(fetcher.mock.calls[64][0]).toBe('/terminal/resize')
  expect(JSON.parse(fetcher.mock.calls[64][1].body)).toEqual({
    cols: 120,
    rows: 40,
  })
  queue.close()
})
