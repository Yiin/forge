// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MessageRow, ToolCallRow } from './MessageRow'

describe('MessageRow', () => {
  afterEach(cleanup)

  it('updates streamed markdown without changing its row identity', async () => {
    const item = {
      kind: 'message' as const,
      id: 'item-1',
      seq: 1,
      role: 'agent' as const,
      text: 'hello',
    }
    const view = render(<MessageRow item={item} />)
    expect(await screen.findByText('hello')).toBeTruthy()
    item.text = 'hello **world**'
    view.rerender(<MessageRow item={item} />)
    expect(await screen.findByText('world')).toBeTruthy()
    expect(view.container.querySelectorAll('.chat-agent')).toHaveLength(1)
  })

  it('exposes thought disclosures to assistive technology', () => {
    render(
      <MessageRow
        item={{
          kind: 'message',
          id: 'thought-1',
          seq: 2,
          role: 'agent',
          thought: true,
          text: 'working',
        }}
      />,
    )

    const disclosure = screen.getByRole('button', { name: /thought/i })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(disclosure.getAttribute('aria-controls')).toBe('thought-thought-1')
  })

  it('keeps message actions keyboard discoverable', () => {
    render(
      <MessageRow
        item={{
          kind: 'message',
          id: 'message-1',
          seq: 3,
          role: 'agent',
          text: 'reply',
        }}
        sessionId="session-1"
      />,
    )

    expect(screen.getByRole('button', { name: 'Copy message' })).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Branch from here' }),
    ).toBeTruthy()
  })

  it('exposes tool detail disclosures', () => {
    render(
      <ToolCallRow
        item={{
          kind: 'tool',
          id: 'tool-1',
          name: 'Search',
          state: 'done',
          input: { query: 'Forge' },
        }}
      />,
    )

    const disclosure = screen.getByRole('button', { name: /searchdone/i })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(disclosure.getAttribute('aria-controls')).toBe('tool-detail-tool-1')
    expect(screen.queryByText('{"query":"Forge"}')).toBeNull()
  })

  it('renders a compact command header and keeps raw input in the detail', () => {
    const view = render(
      <ToolCallRow
        item={{
          kind: 'tool',
          id: 'tool-2',
          name: '`Terminal`',
          state: 'done',
          input: { command: 'hostname', description: 'Check hostname' },
        }}
      />,
    )

    expect(
      screen.getByRole('button', { name: /\$ hostname.*check hostnamedone/i }),
    ).toBeTruthy()
    expect(screen.queryByText(/\{"command":"hostname"/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /\$ hostname/i }))
    expect(view.container.querySelector('pre')?.textContent).toContain(
      '"command": "hostname"',
    )
  })
})
