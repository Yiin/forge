// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AttachmentChips } from './AttachmentChips'

const file = new File(['data'], 'notes.txt', { type: 'text/plain' })

describe('AttachmentChips', () => {
  it('shows the upload error and retry action', () => {
    render(
      <AttachmentChips
        items={[
          {
            id: 'att-1',
            file,
            name: file.name,
            size: file.size,
            mime: file.type,
            progress: 0,
            state: 'failed',
            error: 'Network unavailable',
          },
        ]}
        onRetry={vi.fn()}
        onRemove={vi.fn()}
      />,
    )

    expect(screen.getByText('Network unavailable')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry notes.txt' })).toBeTruthy()
  })

  it('exposes progress as a percentage', () => {
    render(
      <AttachmentChips
        items={[
          {
            id: 'att-1',
            file,
            name: file.name,
            size: file.size,
            mime: file.type,
            progress: 0.42,
            state: 'uploading',
          },
        ]}
        onRetry={vi.fn()}
        onRemove={vi.fn()}
      />,
    )

    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBe(
      '42 percent',
    )
  })
})
