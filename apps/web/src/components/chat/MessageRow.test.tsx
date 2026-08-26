// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MessageRow } from './MessageRow'

describe('MessageRow', () => {
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
})
