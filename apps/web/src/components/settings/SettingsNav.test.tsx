// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { trackSettingsExit } from '../../lib/settings-exit'
import { useShellStore } from '../../stores/shell'
import { SettingsNav } from './SettingsNav'

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn())
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function renderNav(path: string) {
  const root = createRootRoute({ component: SettingsNav })
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  render(<RouterProvider router={router} />)
  return screen.findByRole('navigation', { name: 'Settings' })
}

it('marks only the current page as active', async () => {
  await renderNav('/settings/accounts')
  const active = screen.getByRole('link', { name: 'Accounts' })
  expect(active.getAttribute('aria-current')).toBe('page')
  expect(
    screen.getByRole('link', { name: 'Agents' }).getAttribute('aria-current'),
  ).toBeNull()
  expect(
    screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page'),
  ).toHaveLength(1)
  expect(
    screen.getByRole('link', { name: 'Agents' }).getAttribute('href'),
  ).toBe('/settings/agents')
})

it('closes the drawer and leaves settings from the Back row', async () => {
  useShellStore.setState({ drawerOpen: true })
  const root = createRootRoute({ component: SettingsNav })
  const history = createMemoryHistory({ initialEntries: ['/s/abc'] })
  const router = createRouter({ routeTree: root, history })
  const stop = trackSettingsExit(history)
  history.push('/settings/general')
  history.push('/settings/agents')
  render(<RouterProvider router={router} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Back' }))
  await waitFor(() => expect(history.location.pathname).toBe('/s/abc'))
  expect(useShellStore.getState().drawerOpen).toBe(false)
  stop()
})
