import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixture, until } from './fixtures.js'

describe('workspace descriptor media', () => {
  it('streams ranges, HEAD, empty files, and conditionals with workspace headers', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'clip.mp4'), '0123456789')
    const url = f.url('media', { path: 'clip.mp4' })
    for (const [range, text] of [
      ['bytes=2-5', '2345'],
      ['bytes=-3', '789'],
      ['bytes=7-', '789'],
    ]) {
      const response = await f.app.request(url, { headers: { Range: range! } })
      expect(response.status).toBe(206)
      expect(await response.text()).toBe(text)
      expect(response.headers.get('X-Workspace-Revision')).toBeTruthy()
    }
    const head = await f.app.request(url, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect(head.headers.get('Content-Length')).toBe('10')
    const cached = await f.app.request(url, {
      headers: { 'If-None-Match': head.headers.get('ETag')! },
    })
    expect(cached.status).toBe(304)
    const invalid = await f.app.request(url, {
      headers: { Range: 'bytes=55-99' },
    })
    expect(invalid.status).toBe(416)
    await writeFile(join(f.root, 'empty.mp4'), '')
    const empty = await f.app.request(f.url('media', { path: 'empty.mp4' }))
    expect(empty.status).toBe(200)
    expect(await empty.text()).toBe('')
    await writeFile(join(f.root, '日本語.mp4'), 'media')
    const unicode = await f.app.request(f.url('media', { path: '日本語.mp4' }))
    expect(unicode.status).toBe(200)
    expect(unicode.headers.get('Content-Disposition')).toContain(
      "filename*=UTF-8''",
    )
    expect(await unicode.text()).toBe('media')
    expect(f.service.diagnostics.operations).toBe(0)
  })
  it('serves active documents only as inert downloads', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'active.html'), '<script>unsafe()</script>')
    await writeFile(join(f.root, 'active.svg'), '<svg onload="unsafe()"/>')
    for (const path of ['active.html', 'active.svg']) {
      const response = await f.app.request(f.url('media', { path }))
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe(
        'application/octet-stream',
      )
      expect(response.headers.get('Content-Disposition')).toMatch(/^attachment/)
      expect(response.headers.get('Content-Security-Policy')).toContain(
        'sandbox',
      )
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(response.headers.get('X-Workspace-Media')).toBe('download')
      await response.body?.cancel()
    }
    await until(
      () => f.service.diagnostics.operations,
      (count) => count === 0,
    )
  })
  it('closes descriptors on cancellation and service shutdown while limiting concurrent streams', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'clip.mp4'), Buffer.alloc(1024 * 1024, 97))
    const responses: Response[] = []
    for (let i = 0; i < 8; i++)
      responses.push(await f.app.request(f.url('media', { path: 'clip.mp4' })))
    expect(
      (await f.app.request(f.url('media', { path: 'clip.mp4' }))).status,
    ).toBe(429)
    await responses.pop()!.body!.cancel()
    await until(
      () => f.service.diagnostics.operations,
      (count) => count === 7,
    )
    await f.service.close()
    expect(f.service.diagnostics.operations).toBe(0)
    expect((await f.app.request(f.url('target'))).status).toBe(503)
  })
})
