// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceFilesSurface } from './WorkspaceFilesSurface'
import * as files from '@/lib/workspace-files'

vi.mock('@/lib/workspace-files', async (original) => ({
  ...(await original<typeof files>()),
  listWorkspaceFiles: vi.fn(async () => ({
    entries: ['a.ts', 'b.ts'].map((path) => ({
      path,
      name: path,
      type: 'file',
    })),
  })),
  readWorkspaceFile: vi.fn(async (_selection, path) => snapshot(path)),
  saveWorkspaceFile: vi.fn(),
}))
function snapshot(path: string, text = path, revision = 'one') {
  return {
    file: { path, text, fileRevision: revision, readOnlyReason: null },
  } as any
}
let session = 0
function mount(initialPath = 'a.ts') {
  return render(
    <WorkspaceFilesSurface
      sessionId={`editor-${++session}`}
      target={{ workspaceId: 'w', workspaceRevision: 1 }}
      initialPath={initialPath}
    />,
  )
}
async function edit(text: string) {
  const element = await waitFor(() => {
    const node = document.querySelector('.cm-content')
    expect(node).not.toBeNull()
    return node as HTMLElement
  })
  act(() => {
    const view = EditorView.findFromDOM(element)!
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    })
  })
}
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
})

it('keeps the workspace-change save fence after typing', async () => {
  const sessionId = `editor-${++session}`
  const view = render(
    <WorkspaceFilesSurface
      sessionId={sessionId}
      target={{ workspaceId: 'w', workspaceRevision: 1 }}
      initialPath="a.ts"
    />,
  )
  await edit('before change')
  view.rerender(
    <WorkspaceFilesSurface
      sessionId={sessionId}
      target={{ workspaceId: 'w', workspaceRevision: 2 }}
      initialPath="a.ts"
    />,
  )
  await edit('after change')
  expect(
    (screen.getByRole('button', { name: 'Save file' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true)
  expect(screen.getByText(/Workspace changed/)).toBeTruthy()
})

it('guards dock teardown with the same save/discard/cancel transition', async () => {
  const transitionRef = {
    current: null as ((action: () => void) => void) | null,
  }
  render(
    <WorkspaceFilesSurface
      sessionId={`editor-${++session}`}
      target={{ workspaceId: 'w' }}
      initialPath="a.ts"
      transitionRef={transitionRef}
    />,
  )
  await edit('dirty')
  const closeDock = vi.fn()
  act(() => transitionRef.current!(closeDock))
  expect(closeDock).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
  act(() => transitionRef.current!(closeDock))
  fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
  expect(closeDock).toHaveBeenCalledOnce()
})

it('keeps dirty text until a file replacement is explicitly discarded', async () => {
  mount()
  await edit('unsaved A')
  fireEvent.click(await screen.findByRole('treeitem', { name: 'b.ts' }))
  expect(
    await screen.findByText('Save changes before continuing?'),
  ).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Editor for a.ts' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(document.querySelector('.cm-content')?.textContent).toBe('unsaved A')
  fireEvent.click(screen.getByRole('treeitem', { name: 'b.ts' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
  expect(
    await screen.findByRole('region', { name: 'Editor for b.ts' }),
  ).toBeTruthy()
})

it('keeps newer edits and saving ownership while the original save is pending', async () => {
  let resolve!: (value: any) => void
  vi.mocked(files.saveWorkspaceFile).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  mount()
  await edit('submitted')
  fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
  await edit('newer')
  expect(
    (screen.getByRole('button', { name: 'Save file' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true)
  await act(async () => resolve(snapshot('a.ts', 'submitted', 'two')))
  expect(document.querySelector('.cm-content')?.textContent).toBe('newer')
  expect(
    (screen.getByRole('button', { name: 'Save file' }) as HTMLButtonElement)
      .disabled,
  ).toBe(false)
})

it('does not apply a late save snapshot to a replacement document', async () => {
  let resolve!: (value: any) => void
  vi.mocked(files.saveWorkspaceFile).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  mount()
  await edit('submitted')
  fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
  fireEvent.click(screen.getByRole('treeitem', { name: 'b.ts' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
  await screen.findByRole('region', { name: 'Editor for b.ts' })
  await act(async () => resolve(snapshot('a.ts', 'submitted', 'two')))
  await edit('B edit')
  vi.mocked(files.saveWorkspaceFile).mockResolvedValueOnce(
    snapshot('b.ts', 'B edit', 'three'),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
  expect(
    vi.mocked(files.saveWorkspaceFile).mock.calls.at(-1)?.[1].file.path,
  ).toBe('b.ts')
})

it('retains dirty text across external unmount and remount', async () => {
  const sessionId = `editor-${++session}`
  const props = {
    sessionId,
    target: { workspaceId: 'w', workspaceRevision: 1 },
    initialPath: 'a.ts',
  }
  const view = render(<WorkspaceFilesSurface {...props} />)
  await edit('retained')
  view.unmount()
  render(<WorkspaceFilesSurface {...props} />)
  await waitFor(() =>
    expect(document.querySelector('.cm-content')?.textContent).toBe('retained'),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Close file' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
})

it('settles the original save against edits made after remount', async () => {
  let resolve!: (value: any) => void
  vi.mocked(files.saveWorkspaceFile).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const props = {
    sessionId: `editor-${++session}`,
    target: { workspaceId: 'w' },
    initialPath: 'a.ts',
  }
  const first = render(<WorkspaceFilesSurface {...props} />)
  await edit('submitted')
  fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
  first.unmount()
  render(<WorkspaceFilesSurface {...props} />)
  await edit('remounted edit')
  await act(async () => resolve(snapshot('a.ts', 'submitted', 'two')))
  expect(document.querySelector('.cm-content')?.textContent).toBe(
    'remounted edit',
  )
  expect(
    (screen.getByRole('button', { name: 'Save file' }) as HTMLButtonElement)
      .disabled,
  ).toBe(false)
})

it('requires confirmation before reloading conflicted edits', async () => {
  vi.mocked(files.saveWorkspaceFile).mockRejectedValueOnce(
    new files.WorkspaceFilesError('changed', 'conflict'),
  )
  mount()
  await edit('conflicted edit')
  fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Reload' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
  expect(document.querySelector('.cm-content')?.textContent).toBe(
    'conflicted edit',
  )
})

it('settles an original save after the workspace changes without clearing the target fence', async () => {
  let resolve!: (value: any) => void
  vi.mocked(files.saveWorkspaceFile).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const props = { sessionId: `editor-${++session}`, initialPath: 'a.ts' }
  const view = render(
    <WorkspaceFilesSurface
      {...props}
      target={{ workspaceId: 'w', workspaceRevision: 1 }}
    />,
  )
  await edit('submitted')
  fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
  view.rerender(
    <WorkspaceFilesSurface
      {...props}
      target={{ workspaceId: 'w', workspaceRevision: 2 }}
    />,
  )
  await act(async () => resolve(snapshot('a.ts', 'submitted', 'two')))
  expect(screen.getByText(/Workspace changed/)).toBeTruthy()
  expect(
    (screen.getByRole('button', { name: 'Save file' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Close file' }))
  expect(screen.queryByText('Save changes before continuing?')).toBeNull()
  expect(screen.queryByRole('region', { name: 'Editor for a.ts' })).toBeNull()
})

it('releases a clean retained document when its save completes after unmount', async () => {
  let resolve!: (value: any) => void
  vi.mocked(files.saveWorkspaceFile).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const props = {
    sessionId: `editor-${++session}`,
    target: { workspaceId: 'w' },
    initialPath: 'a.ts',
  }
  const first = render(<WorkspaceFilesSurface {...props} />)
  await edit('submitted')
  fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
  first.unmount()
  await act(async () => resolve(snapshot('a.ts', 'submitted', 'two')))
  vi.mocked(files.readWorkspaceFile).mockResolvedValueOnce(
    snapshot('a.ts', 'new disk text', 'three'),
  )
  render(<WorkspaceFilesSurface {...props} />)
  await waitFor(() =>
    expect(document.querySelector('.cm-content')?.textContent).toBe(
      'new disk text',
    ),
  )
  expect(files.readWorkspaceFile).toHaveBeenCalledTimes(2)
})

it('asks before publishing a delayed read over edits made after that read started', async () => {
  mount()
  await screen.findByRole('region', { name: 'Editor for a.ts' })
  let resolve!: (value: any) => void
  vi.mocked(files.readWorkspaceFile).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  fireEvent.click(await screen.findByRole('treeitem', { name: 'b.ts' }))
  await edit('A edit made during B read')
  await act(async () => resolve(snapshot('b.ts')))
  expect(
    await screen.findByText('Save changes before continuing?'),
  ).toBeTruthy()
  expect(document.querySelector('.cm-content')?.textContent).toBe(
    'A edit made during B read',
  )
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
  expect(
    await screen.findByRole('region', { name: 'Editor for b.ts' }),
  ).toBeTruthy()
  expect(files.readWorkspaceFile).toHaveBeenCalledTimes(2)
})

it('continues a pending close when its earlier toolbar save has already completed', async () => {
  let resolve!: (value: any) => void
  vi.mocked(files.saveWorkspaceFile).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  mount()
  await edit('submitted')
  fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
  fireEvent.click(screen.getByRole('button', { name: 'Close file' }))
  await screen.findByText('Save changes before continuing?')
  await act(async () => resolve(snapshot('a.ts', 'submitted', 'two')))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(
      screen.queryByRole('region', { name: 'Editor for a.ts' }),
    ).toBeNull(),
  )
  expect(files.saveWorkspaceFile).toHaveBeenCalledTimes(1)
})

it('keeps the second file transition through Cancel and a held original save', async () => {
  let resolve!: (value: any) => void
  vi.mocked(files.saveWorkspaceFile).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  mount()
  await edit('original submitted edit')
  fireEvent.click(screen.getByRole('treeitem', { name: 'b.ts' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
  fireEvent.click(screen.getByRole('treeitem', { name: 'b.ts' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
  expect(files.readWorkspaceFile).toHaveBeenCalledTimes(1)
  expect(document.querySelector('.cm-content')?.textContent).toBe(
    'original submitted edit',
  )
  await act(async () =>
    resolve(snapshot('a.ts', 'original submitted edit', 'saved')),
  )
  await waitFor(() =>
    expect(document.querySelector('.cm-content')?.textContent).toBe('b.ts'),
  )
  expect(files.saveWorkspaceFile).toHaveBeenCalledTimes(1)
  expect(files.readWorkspaceFile).toHaveBeenCalledTimes(2)
})

it('anchors an unsaved selected line to the displayed document hash', async () => {
  const { webcrypto, createHash } = await import('node:crypto')
  vi.stubGlobal('crypto', webcrypto)
  const captured = vi.fn()
  const observed = vi.fn()
  vi.mocked(files.readWorkspaceFile).mockResolvedValueOnce({
    ...snapshot('a.ts', 'saved text'),
    workspace: { workspaceId: 'w', workspaceRevision: 1 },
    file: {
      ...snapshot('a.ts', 'saved text').file,
      contentHash: 'a'.repeat(64),
    },
  })
  render(
    <WorkspaceFilesSurface
      sessionId={`editor-${++session}`}
      target={{ workspaceId: 'w', workspaceRevision: 1 }}
      initialPath="a.ts"
      onComment={captured}
      onRevision={observed}
    />,
  )
  try {
    await edit('unsaved text')
    fireEvent.change(
      screen.getByRole('textbox', { name: 'File review note' }),
      { target: { value: 'Keep local edit' } },
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Add note at selected line' }),
    )
    await waitFor(() => expect(captured).toHaveBeenCalledOnce())
    expect(captured.mock.calls[0]![0].anchor.revision).toEqual({
      kind: 'file',
      contentHash: createHash('sha256').update('unsaved text').digest('hex'),
      fileRevision: expect.stringMatching(/^document:/),
    })
    expect(observed.mock.calls.at(-1)?.[1]).toEqual(
      captured.mock.calls[0]![0].anchor.revision,
    )
    await edit('another edit')
    expect(observed.mock.calls.at(-1)?.[1]).toBeNull()
    fireEvent.change(
      screen.getByRole('textbox', { name: 'File review note' }),
      { target: { value: 'Recapture' } },
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Add note at selected line' }),
    )
    await waitFor(() => expect(captured).toHaveBeenCalledTimes(2))
    expect(observed.mock.calls.at(-1)?.[1]).toEqual(
      captured.mock.calls[1]![0].anchor.revision,
    )
    expect(files.saveWorkspaceFile).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllGlobals()
  }
})

it('keeps a later note body while the original dirty hash is held', async () => {
  const { webcrypto } = await import('node:crypto')
  let release!: (value: ArrayBuffer) => void
  const digest = vi.fn(
    () =>
      new Promise<ArrayBuffer>((resolve) => {
        release = resolve
      }),
  )
  vi.stubGlobal('crypto', {
    randomUUID: () => webcrypto.randomUUID(),
    subtle: { digest },
  })
  const captured = vi.fn()
  vi.mocked(files.readWorkspaceFile).mockResolvedValueOnce({
    ...snapshot('a.ts', 'saved'),
    workspace: { workspaceId: 'w', workspaceRevision: 1 },
    file: { ...snapshot('a.ts', 'saved').file, contentHash: 'a'.repeat(64) },
  })
  render(
    <WorkspaceFilesSurface
      sessionId={`editor-${++session}`}
      target={{ workspaceId: 'w', workspaceRevision: 1 }}
      initialPath="a.ts"
      onComment={captured}
    />,
  )
  try {
    await edit('captured text')
    const input = screen.getByRole('textbox', { name: 'File review note' })
    fireEvent.change(input, { target: { value: 'Original note' } })
    fireEvent.click(
      screen.getByRole('button', { name: 'Add note at selected line' }),
    )
    expect(digest).toHaveBeenCalledOnce()
    fireEvent.change(input, { target: { value: 'Later note' } })
    await act(async () =>
      release(
        await webcrypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode('captured text'),
        ),
      ),
    )
    expect(captured.mock.calls[0]![0].body).toBe('Original note')
    expect((input as HTMLInputElement).value).toBe('Later note')
  } finally {
    release?.(new ArrayBuffer(32))
    vi.unstubAllGlobals()
  }
})
