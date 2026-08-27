// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DraftInput } from './draft-input'

function Harness({ onCommit }: { onCommit: (value: string) => void }) {
  const [value, setValue] = useState('initial')
  return (
    <>
      <DraftInput value={value} onCommit={onCommit} aria-label="Name" />
      <button onClick={() => setValue('server value')}>Sync</button>
    </>
  )
}

describe('DraftInput', () => {
  it('commits on blur and Enter, and resyncs controlled values', () => {
    const onCommit = vi.fn()
    render(<Harness onCommit={onCommit} />)
    const input = screen.getByRole('textbox', { name: 'Name' })

    fireEvent.change(input, { target: { value: 'typed' } })
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledOnce()
    expect(onCommit).toHaveBeenLastCalledWith('typed')

    fireEvent.change(input, { target: { value: 'submitted' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledTimes(2)
    expect(onCommit).toHaveBeenLastCalledWith('submitted')

    fireEvent.click(screen.getByRole('button', { name: 'Sync' }))
    expect((input as HTMLInputElement).value).toBe('server value')
  })
})
