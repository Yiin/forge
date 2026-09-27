// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SystemItem } from './TranscriptItems'

describe('SystemItem', () => {
  afterEach(cleanup)

  it('shows the alert title and no recovery buttons without a handler', () => {
    render(
      <SystemItem
        item={{
          kind: 'system',
          id: 'failed',
          title: 'The turn failed.',
          text: 'Failed to authenticate',
          alert: true,
          recovery: 'login',
        }}
      />,
    )
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('The turn failed.')
    expect(alert.textContent).not.toContain('Error')
    expect(screen.queryByRole('button', { name: 'Log in again' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('keeps the default title without one', () => {
    render(
      <SystemItem
        item={{ kind: 'system', id: 'error', text: 'boom', alert: true }}
      />,
    )
    expect(screen.getByRole('alert').textContent).toContain('Error')
  })
})
