// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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

it('closes the drawer and goes back from the Back row', async () => {
  const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
  useShellStore.setState({ drawerOpen: true })
  await renderNav('/settings/general')
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(back).toHaveBeenCalledOnce()
  expect(useShellStore.getState().drawerOpen).toBe(false)
})
