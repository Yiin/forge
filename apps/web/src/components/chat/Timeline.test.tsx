// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '@forge/protocol/message'

const state = { messages: [] as Message[] }

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  useParams: () => ({ sessionId: 'session-1' }),
}))
vi.mock('lucide-react', () => ({
  Bot: () => null,
  Check: () => null,
  ChevronDown: () => null,
  ChevronRight: () => null,
  CircleAlert: () => null,
  Clock3: () => null,
  FileText: () => null,
  LoaderCircle: () => null,
}))
const virtualizerProps: Record<string, unknown>[] = []
vi.mock('virtua', () => ({
  Virtualizer: ({
    data,
    children,
    ...rest
  }: {
    data: unknown[]
    children: (item: unknown) => unknown
  }) => {
    virtualizerProps.push(rest)
    return data.map(children)
  },
}))
vi.mock('../../stores/messages', () => ({
  useMessagesStore: (
    selector: (value: { bySession: Record<string, Message[]> }) => unknown,
  ) => selector({ bySession: { 'session-1': state.messages } }),
}))
vi.mock('./MessageRow', () => ({
  MessageRow: () => null,
  RunningDots: () => null,
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

  afterEach(() => {
    vi.unstubAllGlobals()
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

  it('pins past the inset the bottom spacer reserves', () => {
    // virtua applies its measured height after the commit, and its rows
    // overflow that box, so `scrollHeight` can still leave the spacer out. A
    // pin that stops at `scrollHeight` parks one composer above the bottom.
    state.messages = [message('hello', 1)]
    const scrollTo = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      value: scrollTo,
      configurable: true,
    })
    const view = render(<Timeline bottomInset={120} />)
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
    scrollTo.mockClear()

    state.messages = [message('hello world', 2)]
    view.rerender(<Timeline bottomInset={120} />)

    expect(scrollTo).toHaveBeenCalledWith({ top: 1120 })
  })

  it('re-pins once the measured rows resize the scrolled content', () => {
    const callbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          callbacks.push(callback)
        }
        observe() {}
        disconnect() {}
      },
    )
    state.messages = [message('hello', 1)]
    const scrollTo = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      value: scrollTo,
      configurable: true,
    })
    const view = render(<Timeline bottomInset={120} />)
    const timeline = view.container.querySelector(
      '.chat-timeline',
    ) as HTMLDivElement
    Object.defineProperty(timeline, 'scrollHeight', {
      value: 4826,
      configurable: true,
    })
    scrollTo.mockClear()

    expect(callbacks).toHaveLength(1)
    callbacks[0]([], {} as ResizeObserver)

    expect(scrollTo).toHaveBeenCalledWith({ top: 4946 })
  })

  it('never asks virtua to shift its size cache', () => {
    // Rows are only appended or folded in place. `shift` makes virtua
    // re-index its size cache on every append, so each measured row lands on
    // the next row's slot and blank bands open between rows.
    state.messages = [message('hello', 1)]
    virtualizerProps.length = 0
    render(<Timeline />)
    expect(virtualizerProps[0].shift).toBeFalsy()
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
