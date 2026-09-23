// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from './AppShell'
import { useSessionsStore } from '../stores/sessions'
import { useSettingsStore } from '../stores/settings'
import { resetShortcutRegistry } from '../lib/shortcuts'
import { api } from '../lib/api'
import { useShellStore } from '../stores/shell'
import { harnessHealthResponseSchema } from '@forge/protocol/status'
import codexMark from '../assets/providers/openai.svg'

vi.mock('./palette/CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('./ProjectCreationDialog', () => ({
  ProjectCreationDialog: () => null,
}))
vi.mock('./sidebar/SessionSidebar', () => ({ SessionSidebar: () => null }))
vi.mock('./settings/SettingsNav', () => ({ SettingsNav: () => null }))
vi.mock('./ui/sonner', () => ({ Toaster: () => null }))

beforeEach(() => {
  useShellStore.setState({ sidebarOpen: true, sidebarWidth: 256 })
  vi.stubGlobal('scrollTo', vi.fn())
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.spyOn(useSettingsStore.getState(), 'load').mockResolvedValue(undefined)
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            key: 'work-agent',
            name: 'Work Codex',
            command: 'codex',
            args: [],
            protocol: 'acp',
            enabled: true,
            installed: true,
            liveProcesses: 0,
            accounts: [
              {
                id: 'a1',
                label: 'Work',
                kind: 'codex',
                homePath: '/account',
                order: 0,
                disabled: false,
                authenticated: true,
                cooldown: null,
              },
            ],
          },
        ]),
      ),
    ),
  )
  useSessionsStore.setState({
    sessions: [
      {
        id: 'one',
        title: 'First session',
        harness: 'work-agent',
        accountId: 'a1',
        projectId: 'p1',
        worktreePath: '/repo/.worktrees/feature',
      },
      {
        id: 'two',
        title: 'Second session',
        harness: 'claude',
        projectId: 'p1',
      },
    ],
    projects: [{ id: 'p1', name: 'Main project', path: '/repo' }],
  })
})

afterEach(() => {
  cleanup()
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView
  delete (HTMLElement.prototype as Partial<HTMLElement>).setPointerCapture
  delete (HTMLElement.prototype as Partial<HTMLElement>).releasePointerCapture
  resetShortcutRegistry()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function openShell(path: string) {
  const root = createRootRoute({ component: AppShell })
  const catchAll = createRoute({
    getParentRoute: () => root,
    path: '$',
    component: () => null,
  })
  const history = createMemoryHistory({
    initialEntries: ['/external-entry', path],
    initialIndex: 1,
  })
  const router = createRouter({
    routeTree: root.addChildren([catchAll]),
    history,
  })
  render(<RouterProvider router={router} />)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Go back' })).toBeTruthy(),
  )
  return history
}

const disabled = (name: string) =>
  (screen.getByRole('button', { name }) as HTMLButtonElement).disabled

describe('shell history and session identity', () => {
  it('tracks query, replacement, hash, Back/Forward, and a new branch without leaving the entry boundary', async () => {
    const history = await openShell('/search?q=alpha')
    expect(disabled('Go back')).toBe(true)
    await act(async () => history.push('/search?q=beta'))
    expect(disabled('Go back')).toBe(false)
    await act(async () => history.replace('/search?q=gamma'))
    await act(async () => history.back())
    expect(history.location.search).toBe('?q=alpha')
    expect(disabled('Go back')).toBe(true)
    expect(disabled('Go forward')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Go forward' }))
    await waitFor(() => expect(history.location.search).toBe('?q=gamma'))
    await act(async () => history.back())
    await act(async () => history.push('/runs'))
    expect(disabled('Go forward')).toBe(true)
    fireEvent.click(screen.getByText('Skip to main content'))
    await waitFor(() => expect(history.location.hash).toBe('#main-content'))
    await act(async () => history.back())
    expect(history.location.href).toBe('/runs')
    expect(disabled('Go forward')).toBe(false)
    await act(async () => history.back())
    expect(disabled('Go back')).toBe(true)
  })

  it('gives the visible session one rename owner and shows its provider and worktree', async () => {
    const rename = vi.spyOn(api, 'renameSession').mockResolvedValue({})
    const history = await openShell('/s/one')
    expect(document.querySelectorAll('.session-header')).toHaveLength(1)
    await waitFor(() => expect(screen.getByText('Work Codex')).toBeTruthy())
    expect(screen.getByText('feature').getAttribute('title')).toBe(
      '/repo/.worktrees/feature',
    )
    fireEvent.keyDown(window, { key: 'F2' })
    const input = screen.getByRole('textbox', { name: 'Session title' })
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(rename).toHaveBeenCalledWith('one', 'Renamed'))
    await act(async () => history.push('/s/two'))
    fireEvent.keyDown(window, { key: 'F2' })
    expect(
      (
        screen.getByRole('textbox', {
          name: 'Session title',
        }) as HTMLInputElement
      ).value,
    ).toBe('Second session')
    expect(document.querySelectorAll('.session-header')).toHaveLength(1)
  })

  it('keeps draft titles blank in both header layouts', async () => {
    await openShell('/draft/new')
    expect(screen.queryByText('Chat')).toBeNull()
    expect(document.querySelectorAll('.session-header')).toHaveLength(0)
  })
})

it.each([null, '/repo/.worktrees/old'])(
  'shows persisted cwd instead of project or worktree metadata (%s)',
  async (worktreePath) => {
    useSessionsStore.setState({
      sessions: [
        {
          id: 'cwd',
          title: 'Subdirectory work',
          harness: 'claude',
          projectId: 'p1',
          cwd: '/repo/packages/service',
          worktreePath,
        },
      ],
    })
    await openShell('/s/cwd')
    expect(screen.getByText('service').getAttribute('title')).toBe(
      '/repo/packages/service',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Session information' }))
    expect(screen.getByText('/repo/packages/service')).toBeTruthy()
  },
)

it('uses the configured command to identify an aliased provider after its account is removed', async () => {
  useSessionsStore.setState({
    sessions: [
      {
        id: 'alias',
        title: 'Saved session',
        harness: 'work-agent',
        accountId: null,
      },
    ],
  })
  vi.mocked(fetch).mockResolvedValue(
    new Response(
      JSON.stringify([
        {
          key: 'work-agent',
          name: 'Work Codex',
          command: 'codex',
          args: [],
          protocol: 'acp',
          enabled: true,
          installed: true,
          liveProcesses: 0,
          accounts: [],
        },
      ]),
    ),
  )
  await openShell('/s/alias')
  await waitFor(() => expect(screen.getByText('Work Codex')).toBeTruthy())
  expect(
    document.querySelector<HTMLElement>('.session-header [style*="mask-image"]')
      ?.style.maskImage,
  ).toContain(codexMark)
})

it('retains the header provider read across same-provider sessions and resets rename state', async () => {
  useSessionsStore.setState({
    sessions: [
      {
        id: 'one',
        title: 'First session',
        harness: 'work-agent',
        accountId: 'a1',
      },
      {
        id: 'two',
        title: 'Second session',
        harness: 'work-agent',
        accountId: 'a1',
      },
    ],
  })
  const history = await openShell('/s/one')
  await waitFor(() => expect(screen.getByText('Work Codex')).toBeTruthy())
  fireEvent.keyDown(window, { key: 'F2' })
  expect(screen.getByRole('textbox', { name: 'Session title' })).toBeTruthy()
  await act(async () => history.push('/s/two'))
  expect(screen.queryByRole('textbox', { name: 'Session title' })).toBeNull()
  expect(screen.getByText('Second session')).toBeTruthy()
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('aborts a discarded provider read before consuming or parsing its response', async () => {
  let finish!: (response: Response) => void
  vi.mocked(fetch).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const parse = vi.spyOn(harnessHealthResponseSchema, 'parse')
  const history = await openShell('/s/one')
  const signal = vi.mocked(fetch).mock.calls[0]![1]!.signal!
  expect(signal.aborted).toBe(false)
  await act(async () => history.push('/runs'))
  expect(signal.aborted).toBe(true)
  const json = vi.fn().mockResolvedValue([])
  await act(async () => finish({ ok: true, json } as unknown as Response))
  expect(json).not.toHaveBeenCalled()
  expect(parse).not.toHaveBeenCalled()
})

it('retains full synthetic fork confidence in session information', async () => {
  useSessionsStore.setState({
    sessions: [
      {
        id: 'fork',
        title: 'Fork session',
        harness: 'claude',
        contextMethod: 'synthetic',
      },
    ],
  })
  await openShell('/s/fork')
  expect(
    screen.getByTitle('Synthetic context · reduced confidence'),
  ).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Session information' }))
  expect(
    screen.getByText('Synthetic context · reduced confidence', {
      selector: 'dd',
    }),
  ).toBeTruthy()
})

it('releases resize ownership after collapse and pointer cancellation', async () => {
  const capture = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: capture,
  })
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
    configurable: true,
    value: vi.fn(),
  })
  const pointer = (
    element: Element | Document,
    type: string,
    pointerId: number,
    clientX: number,
  ) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX,
    })
    Object.defineProperty(event, 'pointerId', { value: pointerId })
    fireEvent(element, event)
  }
  await openShell('/settings/general')
  pointer(screen.getByRole('separator'), 'pointerdown', 1, 256)
  await act(async () => useShellStore.getState().toggleSidebar())
  pointer(document, 'lostpointercapture', 1, 256)
  pointer(document, 'pointerup', 1, 256)
  await act(async () => useShellStore.getState().toggleSidebar())
  pointer(screen.getByRole('separator'), 'pointerdown', 2, 256)
  pointer(screen.getByRole('separator'), 'pointermove', 2, 316)
  expect(useShellStore.getState().sidebarWidth).toBe(316)
  pointer(screen.getByRole('separator'), 'pointercancel', 2, 316)
  pointer(screen.getByRole('separator'), 'pointerdown', 3, 316)
  pointer(screen.getByRole('separator'), 'pointermove', 3, 350)
  expect(useShellStore.getState().sidebarWidth).toBe(350)
  expect(capture).toHaveBeenCalledTimes(3)
})
