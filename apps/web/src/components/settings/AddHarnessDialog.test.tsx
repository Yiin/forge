// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AddHarnessDialog } from './AddHarnessDialog'

describe('AddHarnessDialog', () => {
  afterEach(cleanup)
  it('shows errors after a blocked attempt and updates them live', () => {
    render(
      <AddHarnessDialog
        open
        onOpenChange={vi.fn()}
        existingIds={[]}
        onAdd={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Identity/ }))
    fireEvent.change(screen.getByPlaceholderText('e.g. Work'), {
      target: { value: 'Work' },
    })
    fireEvent.change(screen.getByDisplayValue('claude_Work'.toLowerCase()), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('Harness ID is required.')).toBeTruthy()
    fireEvent.change(screen.getByDisplayValue(''), {
      target: { value: 'claude_work' },
    })
    expect(screen.queryByText('Harness ID is required.')).toBeNull()
  })
  it('derives ids until edited and preserves config drafts by kind', () => {
    const onAdd = vi.fn()
    render(
      <AddHarnessDialog
        open
        onOpenChange={vi.fn()}
        existingIds={[]}
        onAdd={onAdd}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Identity/ }))
    fireEvent.change(screen.getAllByPlaceholderText('e.g. Work')[0]!, {
      target: { value: 'Work' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    const command = screen
      .getAllByDisplayValue('claude')
      .find((element) => element.tagName === 'INPUT')!
    fireEvent.change(command, { target: { value: 'claude-work' } })
    fireEvent.click(screen.getByRole('button', { name: /Kind/ }))
    fireEvent.click(screen.getByRole('button', { name: 'codex' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByDisplayValue('codex')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Kind/ }))
    fireEvent.click(screen.getByRole('button', { name: 'claude' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByDisplayValue('claude-work')).toBeTruthy()
  })
})
