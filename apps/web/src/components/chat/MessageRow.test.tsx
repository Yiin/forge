// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MessageRow } from './MessageRow'

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

  it('keeps user message line breaks in the bubble', () => {
    const view = render(
      <MessageRow
        item={{
          kind: 'message',
          id: 'u1',
          seq: 1,
          role: 'user',
          text: '1. foo\n2. bar',
        }}
      />,
    )

    const bubble = view.container.querySelector('.chat-user div')
    expect(bubble?.classList.contains('whitespace-pre-wrap')).toBe(true)
    expect(bubble?.textContent).toContain('1. foo\n2. bar')
  })

  it('keeps literal tags in user messages', () => {
    const view = render(
      <MessageRow
        item={{
          kind: 'message',
          id: 'u2',
          seq: 2,
          role: 'user',
          text: 'hi\n<after>',
        }}
      />,
    )

    expect(view.container.querySelector('.chat-user div')?.textContent).toBe(
      'hi\n<after>',
    )
  })

  it('allows long user messages to collapse without changing the row', () => {
    const view = render(
      <MessageRow
        item={{
          kind: 'message',
          id: 'u4',
          seq: 4,
          role: 'user',
          text: 'long prompt '.repeat(25),
        }}
      />,
    )
    const toggle = screen.getByRole('button', { name: 'Hide message' })
    fireEvent.click(toggle)
    expect(
      screen
        .getByRole('button', { name: 'Show message' })
        .getAttribute('aria-expanded'),
    ).toBe('false')
    expect(view.container.querySelector('.chat-user')).toBeTruthy()
  })

  it('chips only skills listed by the workspace', () => {
    const view = render(
      <MessageRow
        item={{
          kind: 'message',
          id: 'u3',
          seq: 3,
          role: 'user',
          text: '$beads $unknown',
        }}
        skills={['beads']}
      />,
    )

    expect(view.container.textContent).toBe('$beads $unknown')
    expect(view.container.querySelectorAll('span')).toHaveLength(1)
    expect(view.container.querySelector('span')?.textContent).toBe('$beads')
  })
})
