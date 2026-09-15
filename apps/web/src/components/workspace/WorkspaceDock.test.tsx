// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceDock } from './WorkspaceDock'
import { useShellStore } from '@/stores/shell'

vi.mock('./WorkspaceFilesSurface', () => ({
  WorkspaceFilesSurface: () => <div>Files ready</div>,
}))
vi.mock('./TerminalSurface', () => ({ TerminalSurface: () => null }))
vi.mock('./BrowserPreview', () => ({ BrowserPreview: () => null }))
vi.mock('./GitReviewSurface', () => ({ GitReviewSurface: () => null }))
vi.mock('./GitHistorySurface', () => ({ GitHistorySurface: () => null }))
vi.mock('../chat/SubagentTranscript', () => ({
  SubagentTranscript: () => null,
}))
afterEach(cleanup)

it('opens a selected surface from the closed dock without a flex-width sibling', () => {
  const sessionId = 'closed-dock-test'
  useShellStore.getState().closeDock(sessionId)
  render(
    <WorkspaceDock
      sessionId={sessionId}
      projectId="p"
      target={{} as any}
      mobile
    />,
  )
  const trigger = screen.getByRole('button', { name: 'Open workspace dock' })
  expect(trigger.parentElement?.classList.contains('absolute')).toBe(true)
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('button', { name: 'Files' }))
  expect(screen.getByText('Files ready')).toBeTruthy()
  expect(useShellStore.getState().dock(sessionId).open).toBe(true)
})

it('owns only tabs while keeping close actions and arrow navigation accessible', () => {
  const sessionId = 'semantic-dock'
  useShellStore
    .getState()
    .openDockTab(sessionId, { id: 'files', kind: 'files', title: 'Files' })
  useShellStore.getState().openDockTab(sessionId, {
    id: 'terminal',
    kind: 'terminal',
    title: 'Terminal',
  })
  render(
    <WorkspaceDock
      sessionId={sessionId}
      projectId="p"
      target={{ cwd: '/work' }}
    />,
  )
  const list = screen.getByRole('tablist', { name: 'Workspace tabs' })
  const owned = list
    .getAttribute('aria-owns')!
    .split(' ')
    .map((id) => document.getElementById(id)!)
  expect(owned.map((node) => node.getAttribute('role'))).toEqual(['tab', 'tab'])
  expect(
    list.contains(screen.getByRole('button', { name: 'Close Files' })),
  ).toBe(false)
  const terminal = screen.getByRole('tab', { name: 'Terminal' })
  fireEvent.keyDown(terminal, { key: 'ArrowLeft' })
  expect(
    screen.getByRole('tab', { name: 'Files' }).getAttribute('aria-selected'),
  ).toBe('true')
  expect(document.activeElement).toBe(
    screen.getByRole('tab', { name: 'Files' }),
  )
  expect(
    screen
      .getByRole('separator', { name: 'Resize workspace dock' })
      .getAttribute('aria-valuenow'),
  ).toBeTruthy()
})
