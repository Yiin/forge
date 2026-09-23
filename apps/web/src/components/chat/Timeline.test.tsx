// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '@forge/protocol/message'
import type { PendingUserMessage } from '../../stores/messages'

const state = {
  messages: [] as Message[],
  pending: [] as PendingUserMessage[],
}

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  useParams: () => ({ sessionId: 'session-1' }),
}))
vi.mock('./ToolGroup', () => ({
  AgentToolCard: () => null,
  ToolGroup: () => null,
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
    selector: (value: {
      bySession: Record<string, Message[]>
      pendingBySession: Record<string, PendingUserMessage[]>
    }) => unknown,
  ) =>
    selector({
      bySession: { 'session-1': state.messages },
      pendingBySession: { 'session-1': state.pending },
    }),
}))
vi.mock('./MessageRow', () => ({
  MessageRow: () => null,
  RELEASE_FOLLOW_EVENT: 'chat:release-follow',
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
    state.pending = []
    useSessionsStore.setState({ sessions: [] })
  })

  afterEach(() => {
    cleanup()
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

    // The pin aims past the end by the bottom spacer: the composer inset
    // plus zeron's 32px clearance.
    expect(scrollTo).toHaveBeenCalledWith({ top: 1032 })
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

    expect(scrollTo).toHaveBeenCalledWith({ top: 1152 })
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

    // The timeline and the prompt rail each observe the scroller.
    for (const callback of callbacks) callback([], {} as ResizeObserver)

    expect(scrollTo).toHaveBeenCalledWith({ top: 4978 })
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

  it('renders the working line as the last row only while running', () => {
    state.messages = [message('hello', 1)]
    const view = render(<Timeline running />)
    const working = view.container.querySelector('.chat-working')
    expect(working).not.toBeNull()
    const timeline = view.container.querySelector('.chat-timeline')!
    // The last child is the bottom spacer; the row before it is the tail.
    const rows = [...timeline.children].slice(0, -1)
    expect(rows.at(-1)?.contains(working!)).toBe(true)

    view.rerender(<Timeline />)
    expect(view.container.querySelector('.chat-working')).toBeNull()
  })

  it('shows Sending with no timer until the turn starts', () => {
    state.pending = [
      {
        sessionId: 'session-1',
        itemId: 'client_1',
        text: 'hi',
        createdAt: new Date().toISOString(),
      },
    ]
    const view = render(<Timeline />)
    const working = view.container.querySelector('.chat-working')
    expect(working?.textContent).toContain('Sending…')
    expect(working?.textContent).not.toMatch(/\d+s/)
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

  describe('follow', () => {
    const setup = () => {
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
      const size = { scrollHeight: 2000, clientHeight: 500 }
      Object.defineProperty(timeline, 'scrollHeight', {
        get: () => size.scrollHeight,
        configurable: true,
      })
      Object.defineProperty(timeline, 'clientHeight', {
        get: () => size.clientHeight,
        configurable: true,
      })
      const scrollAt = (top: number, input?: 'wheel') => {
        if (input) fireEvent.wheel(timeline)
        timeline.scrollTop = top
        fireEvent.scroll(timeline)
      }
      const grow = (text: string, seq: number) => {
        state.messages = [message(text, seq)]
        scrollTo.mockClear()
        view.rerender(<Timeline />)
      }
      return { view, timeline, size, scrollAt, grow, scrollTo }
    }

    it('lets a wheel scroll release the pin and shows the jump pill', () => {
      const { scrollAt, grow, scrollTo } = setup()
      scrollAt(1500)
      scrollAt(1000, 'wheel')
      expect(screen.getByRole('button', { name: 'Scroll to bottom' }))
      grow('hello again', 2)
      expect(scrollTo).not.toHaveBeenCalled()
    })

    it('keeps following when content grows without user input', () => {
      const { scrollAt, grow, scrollTo, size } = setup()
      scrollAt(1500)
      size.scrollHeight = 2600
      scrollAt(1500)
      grow('hello again', 2)
      expect(scrollTo).toHaveBeenCalled()
      expect(
        screen.queryByRole('button', { name: 'Scroll to bottom' }),
      ).toBeNull()
    })

    it('follows again after a send', () => {
      const { view, scrollAt, scrollTo } = setup()
      scrollAt(1500)
      scrollAt(600, 'wheel')
      scrollTo.mockClear()
      state.pending = [
        {
          sessionId: 'session-1',
          itemId: 'client_1',
          text: 'next',
          createdAt: new Date().toISOString(),
        },
      ]
      view.rerender(<Timeline />)
      expect(scrollTo).toHaveBeenCalled()
      expect(
        screen.queryByRole('button', { name: 'Scroll to bottom' }),
      ).toBeNull()
    })
  })
})
