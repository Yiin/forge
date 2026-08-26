import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createForgeClient } from '../src/index.js'

describe('forge-client', () => {
  it('keeps the vendored status schema byte-identical', async () => {
    const [source, generated] = await Promise.all([
      readFile(new URL('../../protocol/src/status.ts', import.meta.url)),
      readFile(new URL('../src/generated/status.ts', import.meta.url)),
    ])
    expect(generated).toEqual(source)
  })

  it('reconnects the fetch SSE transport after a dropped connection', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    let calls = 0
    const bodies = [
      new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'event: snapshot\ndata: {"type":"snapshot","status":{"version":"v","bootId":"b","uptimeSec":0,"projects":0,"sessions":{"idle":0,"running":0,"errored":0},"epicRuns":{"running":0,"paused":0},"harnesses":[],"dataDirBytes":0}}\n\n',
            ),
          )
          c.close()
        },
      }),
      new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'event: heartbeat\ndata: {"type":"heartbeat","ts":"now"}\n\n',
            ),
          )
          c.close()
        },
      }),
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (!url.endsWith('/api/events'))
          return new Response('{}', { status: 200 })
        return new Response(bodies[calls++] ?? bodies[1], { status: 200 })
      }),
    )
    const events: string[] = []
    const stop = createForgeClient('http://forge/').events((event) =>
      events.push(event.type),
    )
    await vi.waitFor(() => expect(events).toEqual(['snapshot', 'heartbeat']), {
      timeout: 1_000,
    })
    stop()
    vi.restoreAllMocks()
  })

  it('packs only the built distribution', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'forge-client-'))
    await rm(scratch, { recursive: true, force: true })
  })
})
