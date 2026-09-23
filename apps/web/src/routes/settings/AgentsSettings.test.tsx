// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentsSettings } from './AgentsSettings'

const { listHarnesses, saveHarnesses, listHarnessHealth } = vi.hoisted(() => ({
  listHarnesses: vi.fn(),
  saveHarnesses: vi.fn(),
  listHarnessHealth: vi.fn(),
}))
vi.mock('../../lib/api', () => ({ api: { listHarnesses, saveHarnesses } }))
vi.mock('../../lib/accounts-api', () => ({ listHarnessHealth }))

const harness = (name: string, command: string, enabled = true) => ({
  name,
  command,
  args: [] as string[],
  env: {} as Record<string, string>,
  protocol: 'pty' as const,
  enabled,
})
const health = (
  key: string,
  command: string,
  installed: boolean,
  accountCount = 0,
) => ({ key, name: key, command, enabled: true, installed, accountCount })

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn())
  listHarnesses.mockResolvedValue({
    claude: harness('Claude Code', 'claude'),
    mock: harness('Mock', 'mock'),
    codex: harness('Codex', 'codex'),
    hermes: harness('Hermes', 'hermes', false),
  })
  listHarnessHealth.mockResolvedValue([
    health('claude', 'claude', true, 2),
    health('mock', 'mock', true),
    health('codex', 'codex', true, 0),
    health('hermes', 'hermes', false),
  ])
  saveHarnesses.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

async function renderPage() {
  const root = createRootRoute({ component: AgentsSettings })
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/settings/agents'] }),
  })
  render(<RouterProvider router={router} />)
  await screen.findByText('Claude Code')
}

const toggleFor = (name: string) =>
  screen.getByRole('switch', { name: `Enable ${name}` })

it('lists agents in config order with meta and hides mock', async () => {
  await renderPage()
  const names = screen
    .getAllByRole('switch')
    .map((node) => node.getAttribute('aria-label'))
  expect(names).toEqual(['Enable Claude Code', 'Enable Codex', 'Enable Hermes'])
  expect(
    screen.getByRole('link', { name: '2 accounts' }).getAttribute('href'),
  ).toBe('/settings/accounts')
  expect(screen.getByRole('link', { name: 'No accounts' })).toBeTruthy()
  expect(screen.getByText('Install the hermes CLI to enable')).toBeTruthy()
  expect(screen.queryByText('Mock')).toBeNull()
})

it('locks enabling a missing CLI and explains why', async () => {
  await renderPage()
  const hermes = toggleFor('Hermes')
  expect(hermes.getAttribute('aria-readonly')).toBe('true')
  fireEvent.click(hermes)
  expect(saveHarnesses).not.toHaveBeenCalled()
})

it('saves the full map when turning an agent off, keeping row order', async () => {
  await renderPage()
  fireEvent.click(toggleFor('Codex'))
  await waitFor(() => expect(saveHarnesses).toHaveBeenCalledTimes(1))
  const saved = saveHarnesses.mock.calls[0][0]
  expect(Object.keys(saved)).toEqual(['claude', 'mock', 'codex', 'hermes'])
  expect(saved.codex.enabled).toBe(false)
  expect(saved.claude.enabled).toBe(true)
  expect(toggleFor('Codex').getAttribute('aria-checked')).toBe('false')
})

it('keeps the last enabled installed agent on', async () => {
  await renderPage()
  fireEvent.click(toggleFor('Codex'))
  await waitFor(() => expect(saveHarnesses).toHaveBeenCalledTimes(1))
  const claude = toggleFor('Claude Code')
  expect(claude.getAttribute('aria-readonly')).toBe('true')
  const describedBy = claude.getAttribute('aria-describedby')
  expect(document.getElementById(describedBy!)?.textContent).toBe(
    'At least one agent must stay enabled',
  )
  fireEvent.click(claude)
  expect(saveHarnesses).toHaveBeenCalledTimes(1)
})

it('rolls back a failed toggle and shows an error strip', async () => {
  saveHarnesses.mockRejectedValueOnce(new Error('disk full'))
  await renderPage()
  fireEvent.click(toggleFor('Codex'))
  expect(
    (await screen.findByRole('alert')).textContent?.includes(
      'Could not turn off Codex: disk full',
    ),
  ).toBe(true)
  expect(toggleFor('Codex').getAttribute('aria-checked')).toBe('true')
  fireEvent.click(toggleFor('Codex'))
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
})

it('shows a retryable error when loading fails', async () => {
  listHarnesses.mockRejectedValueOnce(new Error('offline'))
  const root = createRootRoute({ component: AgentsSettings })
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/settings/agents'] }),
  })
  render(<RouterProvider router={router} />)
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain('Could not load agents: offline')
  fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText('Claude Code')).toBeTruthy()
})

it('saves Configure edits only on Save', async () => {
  await renderPage()
  fireEvent.click(screen.getByRole('button', { name: 'Configure Codex' }))
  const command = await screen.findByLabelText('Command')
  fireEvent.change(command, { target: { value: 'codex-beta' } })
  fireEvent.change(screen.getByLabelText('Arguments'), {
    target: { value: '--yolo\n\n--fast' },
  })
  expect(saveHarnesses).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(saveHarnesses).toHaveBeenCalledTimes(1))
  const saved = saveHarnesses.mock.calls[0][0]
  expect(saved.codex.command).toBe('codex-beta')
  expect(saved.codex.args).toEqual(['--yolo', '--fast'])
  await waitFor(() => expect(screen.queryByLabelText('Command')).toBeNull())
})
