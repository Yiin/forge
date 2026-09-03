// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QueuedPrompts } from './QueuedPrompts'

const item = { id: 'q1', sessionId: 's1', text: 'queued text', createdAt: 1 }

describe('QueuedPrompts', () => {
  it('renders rows and sends the matching remove and edit actions', () => {
    const onRemove = vi.fn()
    const onEdit = vi.fn()
    render(<QueuedPrompts items={[item]} onRemove={onRemove} onEdit={onEdit} />)

    expect(screen.getByText('queued text')).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove queued message' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
    expect(onRemove).toHaveBeenCalledWith('q1')
    expect(onEdit).toHaveBeenCalledWith(item)
  })

  it('renders nothing for an empty queue', () => {
    const { container } = render(
      <QueuedPrompts items={[]} onRemove={vi.fn()} onEdit={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })
})
