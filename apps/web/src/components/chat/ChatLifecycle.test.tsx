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
        running={false}
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
        running={false}
        empty={false}
      />,
    )
    expect(screen.getByRole('alert').textContent).toContain('503')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('names reconnecting, ready, working, and empty states', () => {
    const view = render(
      <ChatLifecycle
        loading={false}
        onRetry={vi.fn()}
        connection="reconnecting"
        running
        empty
      />,
    )
    expect(screen.getByText(/Reconnecting/).textContent).toContain('preserved')
    expect(screen.getByText(/No messages yet/)).toBeTruthy()
    view.rerender(
      <ChatLifecycle
        loading={false}
        onRetry={vi.fn()}
        connection="connected"
        running
        empty={false}
      />,
    )
    expect(screen.getByRole('status').textContent).toContain('Working')
    view.rerender(
      <ChatLifecycle
        loading={false}
        onRetry={vi.fn()}
        connection="connected"
        running={false}
        empty={false}
      />,
    )
    expect(screen.getByRole('status').textContent).toContain('Ready')
  })
})
