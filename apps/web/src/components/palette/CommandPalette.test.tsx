// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { resetShortcutRegistry, shortcutCommands } from '../../lib/shortcuts'
import { CommandPalette } from './CommandPalette'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/' }),
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView
  resetShortcutRegistry()
})

it('renders its sr-only title only inside the open dialog', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
  render(<CommandPalette />)
  expect(screen.queryByText('Command palette')).toBeNull()
  const open = shortcutCommands().find(({ id }) => id === 'palette.open')
  act(() => open?.action())
  const dialog = await screen.findByRole('dialog', { name: 'Command palette' })
  expect(dialog.contains(screen.getByText('Command palette'))).toBe(true)
  const description = document.getElementById(
    dialog.getAttribute('aria-describedby') ?? '',
  )
  expect(description?.textContent).toBe(
    'Search actions, sessions, and messages',
  )
})
