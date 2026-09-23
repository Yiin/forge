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

  it('clamps a long prompt behind Show more without changing the row', () => {
    const view = render(
      <MessageRow
        item={{
          kind: 'message',
          id: 'u4',
          seq: 4,
          role: 'user',
          text: 'long prompt '.repeat(40),
        }}
      />,
    )
    const more = screen.getByRole('button', { name: /Show more/ })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(view.container.textContent).toContain('...')
    fireEvent.click(more)
    expect(
      screen
        .getByRole('button', { name: /Show less/ })
        .getAttribute('aria-expanded'),
    ).toBe('true')
    expect(view.container.querySelector('.chat-user')).toBeTruthy()
  })

  it('leaves a short prompt unclamped', () => {
    render(
      <MessageRow
        item={{
          kind: 'message',
          id: 'u5',
          seq: 5,
          role: 'user',
          text: 'short prompt',
        }}
      />,
    )
    expect(screen.queryByRole('button', { name: /Show more/ })).toBeNull()
  })

  it('hides the reply lane while its entry is unsettled', () => {
    render(
      <MessageRow
        item={{
          kind: 'message',
          id: 'a1',
          seq: 6,
          role: 'agent',
          text: 'still streaming',
        }}
        sessionId="session-1"
        lane={false}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Branch from here' }),
    ).toBeNull()
  })

  it('keeps Edit and the timestamp in the prompt lane', () => {
    render(
      <MessageRow
        item={{
          kind: 'message',
          id: 'u6',
          seq: 7,
          role: 'user',
          text: 'hello',
          createdAt: '2026-07-01T15:45:00',
        }}
        sessionId="session-1"
      />,
    )
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeTruthy()
    expect(screen.getByText('Jul 1, 3:45 PM')).toBeTruthy()
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
