// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageLightbox } from './ImageLightbox'

function Harness({ onClose }: { onClose?: () => void }) {
  const [src, setSrc] = useState<string | null>(null)
  return (
    <>
      <button type="button" onClick={() => setSrc('/shot.png')}>
        Open
      </button>
      <ImageLightbox
        src={src}
        name="shot.png"
        onClose={() => {
          onClose?.()
          setSrc(null)
        }}
      />
    </>
  )
}

afterEach(cleanup)

describe('ImageLightbox', () => {
  it('shows the image and its name, loading until it decodes', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('Open'))
    const dialog = await screen.findByRole('dialog', { name: 'shot.png' })
    expect(dialog.textContent).toContain('Loading image…')
    expect(screen.getByAltText('shot.png')).toBeTruthy()
  })

  it('closes on a click and on Escape', async () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    fireEvent.click(screen.getByText('Open'))
    fireEvent.click(await screen.findByRole('dialog'))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('Open'))
    const dialog = await screen.findByRole('dialog')
    await act(async () => {
      fireEvent.keyDown(dialog, { key: 'Escape' })
    })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('does not close when the press was a drag', async () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    fireEvent.click(screen.getByText('Open'))
    const image = await screen.findByAltText('shot.png')
    const viewport = image.parentElement!
    fireEvent.pointerDown(viewport, {
      pointerId: 1,
      button: 0,
      clientX: 10,
      clientY: 10,
    })
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 40, clientY: 10 })
    fireEvent.pointerUp(viewport, { pointerId: 1 })
    fireEvent.click(viewport)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(viewport)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
