// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  act,
} from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { GitReviewSurface } from './GitReviewSurface'
import { GitHistorySurface } from './GitHistorySurface'
vi.mock('../../lib/api', () => ({
  api: {
    gitDiff: vi.fn(),
    gitStatus: vi.fn(),
    gitBranches: vi.fn(),
    gitHistory: vi.fn(),
  },
}))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.resetAllMocks()
})
const line = (type: 'deletion' | 'addition' | 'context', text: string) => ({
  type,
  text,
  oldLine: type === 'addition' ? null : 1,
  newLine: type === 'deletion' ? null : 1,
})
const diff = (text = 'new') => ({
  scope: 'working',
  revision: 'rev',
  additions: 1,
  deletions: 1,
  truncated: true,
  files: [
    {
      oldPath: 'old.txt',
      newPath: 'new.txt',
      status: 'renamed',
      additions: 1,
      deletions: 1,
      contentTruncated: true,
      hunks: [
        {
          oldStart: 1,
          oldCount: 1,
          newStart: 1,
          newCount: 1,
          lines: [line('deletion', 'old'), line('addition', text)],
        },
      ],
    },
  ],
})
function setup() {
  vi.mocked(api.gitStatus).mockResolvedValue({ defaultBranch: 'main' })
  vi.mocked(api.gitBranches).mockResolvedValue({ refs: [{ name: 'main' }] })
  vi.mocked(api.gitDiff).mockResolvedValue(diff())
}
it('shows truncation and keeps paired old/new comments under their original side', async () => {
  setup()
  const comment = vi.fn()
  vi.spyOn(window, 'prompt').mockReturnValue('note')
  render(
    <GitReviewSurface
      workspace={{ workspaceId: 'w', workspaceRevision: 1 }}
      projectId="p"
      sessionId="s"
      cwd="/tmp"
      onComment={comment}
    />,
  )
  await screen.findByText('File diff truncated. Some lines are omitted.')
  expect(
    screen.getByText('Diff truncated. Some files or lines are omitted.'),
  ).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Split' }))
  expect(screen.getByRole('table', { name: 'Split diff' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Comment on old line 1' }))
  fireEvent.click(screen.getByRole('button', { name: 'Comment on new line 1' }))
  expect(
    comment.mock.calls.map((call) => ({
      side: call[0].anchor.side,
      line: call[0].anchor.line,
      oldPath: call[0].anchor.oldPath,
      newPath: call[0].anchor.newPath,
      body: call[0].body,
    })),
  ).toEqual([
    {
      oldPath: 'old.txt',
      newPath: 'new.txt',
      side: 'old',
      line: 1,
      body: 'note',
    },
    {
      oldPath: 'old.txt',
      newPath: 'new.txt',
      side: 'new',
      line: 1,
      body: 'note',
    },
  ])
  fireEvent.click(screen.getByRole('button', { name: 'Wrap' }))
  expect(
    screen
      .getByRole('table', { name: 'Split diff' })
      .classList.contains('table-fixed'),
  ).toBe(true)
})
it('keeps commit tabs immutable and refuses late content from another commit', async () => {
  setup()
  let finish!: (value: unknown) => void
  vi.mocked(api.gitDiff).mockImplementation(async (_project, params) =>
    params?.commit === 'first'
      ? new Promise((resolve) => {
          finish = resolve
        })
      : diff('second'),
  )
  const view = render(
    <GitReviewSurface
      workspace={{ workspaceId: 'w', workspaceRevision: 1 }}
      projectId="p"
      sessionId="s"
      cwd="/tmp"
      commit="first"
      onComment={() => {}}
    />,
  )
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  view.rerender(
    <GitReviewSurface
      workspace={{ workspaceId: 'w', workspaceRevision: 1 }}
      projectId="p"
      sessionId="s"
      cwd="/tmp"
      commit="second"
      onComment={() => {}}
    />,
  )
  await screen.findByText('second')
  await act(async () => {
    finish(diff('stale'))
  })
  expect(screen.queryByText('stale')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Working tree' })).toBeNull()
})
it('refreshes branch suggestions and preserves filters in subsequent requests', async () => {
  setup()
  vi.mocked(api.gitHistory).mockResolvedValue({
    commits: [
      {
        sha: 'a',
        parents: ['b'],
        refs: ['refs/heads/main'],
        author: 'Author',
        date: '2026-01-01',
        subject: 'needle',
      },
    ],
    revision: 'a',
    nextCursor: 'cursor',
  })
  render(
    <GitHistorySurface
      projectId="p"
      sessionId="s"
      cwd="/tmp"
      onCommit={() => {}}
    />,
  )
  await screen.findByRole('button', { name: /needle/ })
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Search commit messages' }),
    { target: { value: 'needle' } },
  )
  fireEvent.click(screen.getByRole('button', { name: 'Search' }))
  await waitFor(() =>
    expect(api.gitHistory).toHaveBeenLastCalledWith(
      'p',
      expect.objectContaining({ query: 'needle' }),
    ),
  )
  await screen.findByRole('button', { name: 'Load more' })
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  await waitFor(() =>
    expect(api.gitHistory).toHaveBeenLastCalledWith(
      'p',
      expect.objectContaining({ query: 'needle', cursor: 'cursor' }),
    ),
  )
  const before = vi.mocked(api.gitBranches).mock.calls.length
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: 'Refresh history' })
        .hasAttribute('disabled'),
    ).toBe(false),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Refresh history' }))
  await waitFor(() =>
    expect(vi.mocked(api.gitBranches).mock.calls.length).toBe(before + 1),
  )
})

it('keeps a manual base selection when initial status resolves late', async () => {
  setup()
  let finish!: (value: unknown) => void
  vi.mocked(api.gitStatus).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  render(
    <GitReviewSurface
      workspace={{ workspaceId: 'w', workspaceRevision: 1 }}
      projectId="p"
      sessionId="s"
      cwd="/tmp"
      onComment={() => {}}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Branch' }))
  fireEvent.change(screen.getByRole('combobox', { name: 'Diff base branch' }), {
    target: { value: 'release' },
  })
  await act(async () => {
    finish({ defaultBranch: 'main' })
  })
  expect(
    (
      screen.getByRole('combobox', {
        name: 'Diff base branch',
      }) as HTMLInputElement
    ).value,
  ).toBe('release')
  expect(api.gitDiff).toHaveBeenLastCalledWith(
    'p',
    expect.objectContaining({ scope: 'branch', baseRef: 'release' }),
  )
})
