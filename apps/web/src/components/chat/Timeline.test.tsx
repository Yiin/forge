// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '@forge/protocol/message'

const state = { messages: [] as Message[] }

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  useParams: () => ({ sessionId: 'session-1' }),
}))
vi.mock('lucide-react', () => ({
  Check: () => null,
  ChevronDown: () => null,
  ChevronRight: () => null,
  CircleAlert: () => null,
  Clock3: () => null,
  FileText: () => null,
  LoaderCircle: () => null,
}))
vi.mock('virtua', () => ({
  Virtualizer: ({
    data,
    children,
  }: {
    data: unknown[]
    children: (item: unknown) => unknown
  }) => data.map(children),
}))
vi.mock('../../stores/messages', () => ({
  useMessagesStore: (
    selector: (value: { bySession: Record<string, Message[]> }) => unknown,
  ) => selector({ bySession: { 'session-1': state.messages } }),
}))
vi.mock('./MessageRow', () => ({
  MessageRow: () => null,
  ToolCallRow: () => null,
}))

import { useSessionsStore } from '../../stores/sessions'
import { Timeline } from './Timeline'

const message = (text: string, seq: number): Message => ({
  seq,
  sessionId: 'session-1',
  turnId: 'turn-1',
  itemId: 'item-1',
  role: 'agent',
  type: 'text_delta',
  content: { type: 'text_delta', text },
  createdAt: new Date(0).toISOString(),
})

describe('Timeline', () => {
  beforeEach(() => {
    state.messages = []
    useSessionsStore.setState({ sessions: [] })
  })

  it('keeps a pinned timeline at the latest streamed text', () => {
    state.messages = [message('hello', 1)]
    const scrollTo = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      value: scrollTo,
      configurable: true,
    })
    const view = render(<Timeline />)
    const timeline = view.container.querySelector(
      '.chat-timeline',
    ) as HTMLDivElement
    Object.defineProperty(timeline, 'scrollHeight', {
      value: 1000,
      configurable: true,
    })
    Object.defineProperty(timeline, 'clientHeight', {
      value: 500,
      configurable: true,
    })

    state.messages = [message('hello world', 2)]
    view.rerender(<Timeline />)

    expect(scrollTo).toHaveBeenCalledWith({ top: 1000 })
  })

  it('renders a subagent card without an update loop', () => {
    state.messages = [message('hello', 1)]
    useSessionsStore.setState({
      sessions: [
        {
          id: 'child-1',
          title: 'Child work',
          parentSessionId: 'session-1',
          spawnedBySeq: 1,
          status: 'running',
        },
      ],
    })
    const view = render(<Timeline />)
    expect(view.container.querySelector('.subagent-card')).not.toBeNull()
  })
})
