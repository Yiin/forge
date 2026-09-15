// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useWorkspaceTarget } from './useWorkspaceTarget'
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const body = (sessionId: string) => ({
  workspace: {
    target: { kind: 'session', sessionId },
    projectId: 'p',
    cwd: '/work',
    worktreePath: null,
    workspaceId: `workspace-${sessionId}`,
    workspaceRevision: 3,
  },
})
it('loads authoritative creation fields without listing files and rejects late navigation results', async () => {
  let first!: (response: Response) => void
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          first = resolve
        }),
    )
    .mockResolvedValueOnce(Response.json(body('b')))
  vi.stubGlobal('fetch', fetcher)
  const hook = renderHook(({ id }) => useWorkspaceTarget(id), {
    initialProps: { id: 'a' },
  })
  hook.rerender({ id: 'b' })
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true)
  await waitFor(() =>
    expect(hook.result.current.target).toMatchObject({
      workspaceId: 'workspace-b',
      workspaceRevision: 3,
    }),
  )
  await act(async () => {
    first(Response.json(body('a')))
  })
  expect(hook.result.current.target).toMatchObject({
    workspaceId: 'workspace-b',
  })
  expect(
    fetcher.mock.calls.every(([url]) =>
      url.startsWith('/api/workspace/target?'),
    ),
  ).toBe(true)
})
it('shows failure and retries the original session target', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(Response.json(body('a'))),
  )
  const hook = renderHook(() => useWorkspaceTarget('a'))
  await waitFor(() => expect(hook.result.current.error).toContain('503'))
  act(() => hook.result.current.retry())
  await waitFor(() =>
    expect(hook.result.current.target).toMatchObject({
      workspaceId: 'workspace-a',
    }),
  )
  expect(hook.result.current.error).toBeUndefined()
})

it('removes stale authority while the same session changes workspace', async () => {
  let release!: (response: Response) => void
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(body('a')))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
  vi.stubGlobal('fetch', fetcher)
  const hook = renderHook(({ path }) => useWorkspaceTarget('a', path), {
    initialProps: { path: '/old' },
  })
  await waitFor(() =>
    expect(hook.result.current.target).toMatchObject({ workspaceRevision: 3 }),
  )
  hook.rerender({ path: '/new' })
  expect(hook.result.current.target).toEqual({ cwd: null })
  const updated = body('a')
  updated.workspace.cwd = '/new'
  updated.workspace.workspaceRevision = 4
  await act(async () => {
    release(Response.json(updated))
  })
  expect(hook.result.current.target).toMatchObject({
    cwd: '/new',
    workspaceRevision: 4,
  })
  expect(fetcher).toHaveBeenCalledTimes(2)
})
