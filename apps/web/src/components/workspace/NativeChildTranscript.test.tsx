// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  waitFor,
  fireEvent,
} from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChildTranscript } from './NativeChildTranscript'
vi.mock('../chat/SubagentTranscript', () => ({
  SubagentTranscript: ({
    messages,
  }: {
    messages: Array<{ content: { text?: string } }>
  }) => <div>{messages.map((message) => message.content.text).join('')}</div>,
}))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const message = (text: string, seq = 1, childId = 'child/one') => ({
  seq,
  sessionId: 'parent/one',
  turnId: 'turn',
  itemId: 'text',
  role: 'agent',
  type: 'text_delta',
  content: { type: 'text_delta', text, childId },
  createdAt: new Date(0).toISOString(),
})
it('reads exact parent-child pages and folds their original sequence', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        messages: [message('first ')],
        cursor: 1,
        hasMore: true,
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        messages: [message('second', 2)],
        cursor: 2,
        hasMore: false,
      }),
    )
  vi.stubGlobal('fetch', fetch)
  const view = render(
    <NativeChildTranscript sessionId="parent/one" childId="child/one" />,
  )
  await screen.findByText('first second')
  expect(fetch.mock.calls.map((call) => call[0])).toEqual([
    '/api/sessions/parent%2Fone/native-children/child%2Fone/messages?after=0&limit=200',
    '/api/sessions/parent%2Fone/native-children/child%2Fone/messages?after=1&limit=200',
  ])
  const signal = fetch.mock.calls[0][1].signal
  view.unmount()
  expect(signal.aborted).toBe(true)
})
it('rejects a foreign child and retries from a clean cursor', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        messages: [message('foreign', 1, 'other')],
        cursor: 1,
        hasMore: false,
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        messages: [message('owned')],
        cursor: 1,
        hasMore: false,
      }),
    )
  vi.stubGlobal('fetch', fetch)
  render(<NativeChildTranscript sessionId="parent/one" childId="child/one" />)
  expect((await screen.findByRole('alert')).textContent).toContain(
    'ownership changed',
  )
  expect(screen.queryByText('foreign')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('owned')
  expect(fetch.mock.calls[1][0]).toContain('after=0')
})
it('ignores an original response after navigation', async () => {
  let release!: (response: Response) => void
  const pending = new Promise<Response>((resolve) => {
    release = resolve
  })
  const fetch = vi
    .fn()
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce(
      Response.json({
        messages: [message('new child', 2, 'child/two')],
        cursor: 2,
        hasMore: false,
      }),
    )
  vi.stubGlobal('fetch', fetch)
  const view = render(
    <NativeChildTranscript sessionId="parent/one" childId="child/one" />,
  )
  view.rerender(
    <NativeChildTranscript sessionId="parent/one" childId="child/two" />,
  )
  await screen.findByText('new child')
  release(
    Response.json({
      messages: [message('old child')],
      cursor: 1,
      hasMore: false,
    }),
  )
  await waitFor(() => expect(fetch.mock.calls[0][1].signal.aborted).toBe(true))
  expect(screen.queryByText('old child')).toBeNull()
  expect(screen.getByText('new child')).toBeTruthy()
})
