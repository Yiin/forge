// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Button } from './button'
import { ConfirmationDialog } from './confirmation-dialog'
import { Dialog } from './dialog'
import {
  MenuContent,
  MenuItem,
  MenuTrigger,
  DropdownMenu,
} from './dropdown-menu'
import { StatusPanel } from './status-panel'

describe('interaction primitives', () => {
  it('keeps focus inside a dialog and restores it after Escape', async () => {
    const onOpenChange = vi.fn()
    const { rerender } = render(
      <>
        <button>Open</button>
        <Dialog open={false} onOpenChange={onOpenChange}>
          <button>First</button>
          <button>Last</button>
        </Dialog>
      </>,
    )
    const open = screen.getByRole('button', { name: 'Open' })
    open.focus()
    rerender(
      <>
        <button>Open</button>
        <Dialog open onOpenChange={onOpenChange}>
          <button>First</button>
          <button>Last</button>
        </Dialog>
      </>,
    )
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'First' }),
      ),
    )
    fireEvent.keyDown(screen.getByRole('button', { name: 'First' }), {
      key: 'Escape',
    })
    rerender(
      <>
        <button>Open</button>
        <Dialog open={false} onOpenChange={onOpenChange}>
          <button>First</button>
          <button>Last</button>
        </Dialog>
      </>,
    )
    expect(open === document.activeElement).toBe(true)
  })

  it('supports menu arrows, Home, End, and Escape', () => {
    render(
      <DropdownMenu>
        <MenuTrigger>More</MenuTrigger>
        <MenuContent>
          <MenuItem>One</MenuItem>
          <MenuItem>Two</MenuItem>
        </MenuContent>
      </DropdownMenu>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    const one = screen.getByRole('menuitem', { name: 'One' })
    const two = screen.getByRole('menuitem', { name: 'Two' })
    fireEvent.keyDown(one, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(two)
    fireEvent.keyDown(two, { key: 'Home' })
    expect(document.activeElement).toBe(one)
    fireEvent.keyDown(one, { key: 'End' })
    expect(document.activeElement).toBe(two)
    fireEvent.keyDown(two, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('prevents repeated confirmation while async work is pending', async () => {
    let resolve!: () => void
    const confirm = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done
        }),
    )
    render(
      <ConfirmationDialog open onOpenChange={vi.fn()} onConfirm={confirm}>
        Delete this?
      </ConfirmationDialog>,
    )
    const button = screen.getByRole('button', { name: 'Confirm' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(confirm).toHaveBeenCalledOnce()
    expect((button as HTMLButtonElement).disabled).toBe(true)
    resolve()
    await waitFor(() =>
      expect((button as HTMLButtonElement).disabled).toBe(false),
    )
  })

  it('exposes distinct feedback semantics and actions', () => {
    const retry = vi.fn()
    render(
      <>
        <StatusPanel status="loading" message="Loading" />
        <StatusPanel status="error" message="Failed" onRetry={retry} />
        <StatusPanel
          status="empty"
          message="Nothing"
          action={{ label: 'Create', onClick: vi.fn() }}
        />
        <Button loading>Save</Button>
      </>,
    )
    const loading = screen.getByRole('status')
    expect(loading.textContent).toBe('Loading')
    expect(loading.getAttribute('aria-busy')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy()
  })
})
