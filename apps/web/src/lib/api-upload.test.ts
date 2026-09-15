// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { ForgeApi } from './api'
import { putUpload } from './upload'

vi.mock('./upload', () => ({ putUpload: vi.fn(async () => {}) }))
it.each([undefined, 'project'])(
  'routes explicit draft uploads with project %s',
  async (projectId) => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ attachmentId: 'a', putUrl: '/put' })),
    )
    const api = new ForgeApi({
      baseUrl: 'http://fixture',
      fetch: fetcher as typeof fetch,
    })
    const file = new File(['bytes'], 'file.txt', { type: 'text/plain' })
    await api.upload('draft', file, undefined, { draftId: 'draft', projectId })
    expect((fetcher.mock.calls[0] as any)[0]).toBe(
      'http://fixture/api/drafts/draft/uploads',
    )
    const init = (fetcher.mock.calls[0] as any)[1]
    expect(new Headers(init.headers).get('X-Project-Id')).toBe(
      projectId ?? null,
    )
    expect(JSON.parse(init.body)).toMatchObject({
      filename: 'file.txt',
      mime: 'text/plain',
      sizeBytes: 5,
    })
    expect(putUpload).toHaveBeenCalledWith(
      { attachmentId: 'a', putUrl: '/put' },
      file,
      'http://fixture',
      undefined,
    )
  },
)
