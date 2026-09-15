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
