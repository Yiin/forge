// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceBar } from './WorkspaceBar'
import { api } from '../../lib/api'
import { useSessionsStore, type SessionSummary } from '../../stores/sessions'

const session = (patch: Partial<SessionSummary> = {}) =>
  ({
    id: 'session-1',
    projectId: 'project-1',
    branch: 'main',
    worktreePath: null,
    ...patch,
  }) as SessionSummary

describe('WorkspaceBar in a session', () => {
  beforeEach(() => {
    vi.spyOn(api, 'gitStatus').mockResolvedValue({
      isRepo: true,
      branch: 'main',
    } as never)
    vi.spyOn(api, 'gitBranches').mockResolvedValue({
      isRepo: true,
      hasRemote: false,
      refs: [
        {
          name: 'main',
          current: true,
          isDefault: true,
          isRemote: false,
          remoteName: null,
          worktreePath: null,
        },
        {
          name: 'feature',
          current: false,
          isDefault: false,
          isRemote: false,
          remoteName: null,
          worktreePath: null,
        },
      ],
      nextCursor: null,
      totalCount: 2,
    } as never)
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useSessionsStore.setState({ sessions: [] })
  })

  it('switches the branch of an idle session through the workspace API', async () => {
    useSessionsStore.setState({ sessions: [session()] })
    const setWorkspace = vi
      .spyOn(api, 'setSessionWorkspace')
      .mockResolvedValue({} as never)
    vi.spyOn(api, 'getSession').mockResolvedValue(
      session({ branch: 'feature' }),
    )
    render(<WorkspaceBar projectId="project-1" sessionId="session-1" />)
    const branch = await screen.findByRole('button', { name: 'Branch' })
    expect(branch.textContent).toBe('main')
    expect(screen.getByRole('button', { name: 'Workspace' })).toBeTruthy()
    fireEvent.click(branch)
    fireEvent.click(await screen.findByRole('option', { name: 'feature' }))
    await vi.waitFor(() =>
      expect(setWorkspace).toHaveBeenCalledWith('session-1', {
        mode: 'local',
        branch: 'feature',
      }),
    )
  })

  it.each([
    ['running', session(), true, 'Local checkout'],
    [
      'in its own worktree',
      session({ worktreePath: '/tmp/wt' }),
      false,
      'Worktree',
    ],
  ])(
    'shows read-only labels while the session is %s',
    async (_state, value, disabled, label) => {
      useSessionsStore.setState({ sessions: [value] })
      render(
        <WorkspaceBar
          projectId="project-1"
          sessionId="session-1"
          disabled={disabled}
        />,
      )
      expect((await screen.findByLabelText('Workspace')).textContent).toBe(
        label,
      )
      expect(screen.getByLabelText('Branch').textContent).toBe('main')
      expect(screen.queryByRole('button', { name: 'Branch' })).toBeNull()
    },
  )
})
