// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectSettings } from './settings-pages-implementation'

const {
  listSettingsProjects,
  listWorktrees,
  removeWorktree,
  renameProject,
  archiveProjectById,
} = vi.hoisted(() => ({
  listSettingsProjects: vi.fn(),
  listWorktrees: vi.fn(),
  removeWorktree: vi.fn(),
  renameProject: vi.fn(),
  archiveProjectById: vi.fn(),
}))

vi.mock('../lib/api', () => ({
  api: {
    listSettingsProjects,
    listWorktrees,
    removeWorktree,
    renameProject,
    archiveProjectById,
  },
}))
vi.mock('../components/ProjectCreationDialog', () => ({
  openProjectCreation: vi.fn(),
}))

describe('ProjectSettings worktrees', () => {
  afterEach(cleanup)
  beforeEach(() => {
    vi.clearAllMocks()
    listSettingsProjects.mockResolvedValue([
      { id: 'p1', name: 'Forge', path: '/repo' },
    ])
    listWorktrees.mockResolvedValue({
      worktrees: [
        {
          path: '/data/clean',
          branch: 'feature/clean',
          dirty: false,
          activeSession: false,
        },
        {
          path: '/data/dirty',
          branch: 'feature/dirty',
          dirty: true,
          activeSession: false,
        },
        {
          path: '/data/active',
          branch: 'feature/active',
          dirty: false,
          activeSession: true,
        },
      ],
    })
    removeWorktree.mockResolvedValue({ ok: true })
    renameProject.mockResolvedValue({ ok: true })
    archiveProjectById.mockResolvedValue({ ok: true })
  })

  it('lists worktrees with state and removes a removable worktree', async () => {
    render(<ProjectSettings />)
    expect(await screen.findByText('feature/clean')).toBeTruthy()
    expect(screen.getByText('Uncommitted changes.')).toBeTruthy()
    expect(screen.getByText('Active session uses this worktree.')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Remove worktree feature/active' }),
    ).toHaveProperty('disabled', true)

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove worktree feature/clean' }),
    )
    await waitFor(() =>
      expect(removeWorktree).toHaveBeenCalledWith('p1', {
        path: '/data/clean',
      }),
    )
    await waitFor(() => expect(screen.queryByText('feature/clean')).toBeNull())
  })

  it('shows loading and API errors', async () => {
    let resolve!: (value: unknown) => void
    listWorktrees.mockImplementation(
      () =>
        new Promise((next) => {
          resolve = next
        }),
    )
    render(<ProjectSettings />)
    expect(await screen.findByText('Loading…')).toBeTruthy()
    resolve({ worktrees: [] })
    await waitFor(() =>
      expect(screen.getByText('No session worktrees.')).toBeTruthy(),
    )
  })

  it('shows an error and retry action when listing fails', async () => {
    listWorktrees.mockRejectedValue(new Error('offline'))
    render(<ProjectSettings />)
    expect(await screen.findByText('Could not load worktrees.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })
})
