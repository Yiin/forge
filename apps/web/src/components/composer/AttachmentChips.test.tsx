// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentChips } from './AttachmentChips'

const file = new File(['data'], 'notes.txt', { type: 'text/plain' })

afterEach(cleanup)

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

  it('opens an image thumb in the lightbox and not when removing it', async () => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:shot',
      revokeObjectURL: () => undefined,
    })
    const image = new File(['png'], 'shot.png', { type: 'image/png' })
    const onRemove = vi.fn()
    render(
      <AttachmentChips
        items={[
          {
            id: 'att-2',
            file: image,
            name: image.name,
            size: image.size,
            mime: image.type,
            progress: 1,
            state: 'complete',
          },
        ]}
        onRetry={vi.fn()}
        onRemove={onRemove}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove shot.png' }))
    expect(onRemove).toHaveBeenCalledWith('att-2')
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Preview shot.png' }))
    expect(await screen.findByRole('dialog', { name: 'shot.png' })).toBeTruthy()
    cleanup()
    vi.unstubAllGlobals()
  })
})
