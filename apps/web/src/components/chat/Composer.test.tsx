// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Composer } from './Composer'

describe('Composer', () => {
  it('exposes the manual end-turn action for a running PTY session', () => {
    const onInterrupt = vi.fn().mockResolvedValue(undefined)

    render(
      <Composer
        sessionId="session-1"
        protocol="pty"
        running
        onInterrupt={onInterrupt}
        onSend={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'End turn' }))

    expect(onInterrupt).toHaveBeenCalledOnce()
  })
})
