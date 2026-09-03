// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatLifecycle } from './ChatLifecycle'

describe('ChatLifecycle', () => {
  it('shows loading and failed load retry states', () => {
    const onRetry = vi.fn()
    const view = render(
      <ChatLifecycle
        loading
        onRetry={onRetry}
        connection="connecting"
        empty={false}
      />,
    )
    expect(screen.getByRole('status').textContent).toContain('Loading session')
    view.rerender(
      <ChatLifecycle
        loading={false}
        error="Session could not be loaded (503)"
        onRetry={onRetry}
        connection="disconnected"
        empty={false}
      />,
    )
    expect(screen.getByRole('alert').textContent).toContain('503')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('keeps reconnecting text but hides the connected status band', () => {
    const view = render(
      <ChatLifecycle
        loading={false}
        onRetry={vi.fn()}
        connection="reconnecting"
        empty
      />,
    )
    expect(screen.getByText(/Reconnecting/).textContent).toContain('preserved')
    expect(screen.queryByText(/No messages yet/)).toBeNull()
    view.rerender(
      <ChatLifecycle
        loading={false}
        onRetry={vi.fn()}
        connection="connected"
        empty={false}
      />,
    )
    expect(view.container.textContent).toBe('')
    expect(screen.queryByRole('status')).toBeNull()
  })
})
