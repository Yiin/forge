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
/**
 * Row geometry the mocked virtua reports: offsets from `rowHeights`. Rows in
 * `estimated` are sized from virtua's average, `estimate`, until measured,
 * and rows in `hidden` are not rendered at all.
 */
const layout = {
  rowHeights: [] as number[],
  estimated: new Set<number>(),
  hidden: new Set<number>(),
  estimate: 0,
}
/** virtua's size for a row: its estimate until it is measured. */
const virtuaSize = (index: number) =>
  layout.estimated.has(index)
    ? layout.estimate
    : (layout.rowHeights[index] ?? 0)
const rowOffset = (index: number) =>
  layout.rowHeights.slice(0, index).reduce((sum, height) => sum + height, 0)
const handle = {
  getItemOffset: (index: number) =>
    Array.from({ length: index }, (_, row) => virtuaSize(row)).reduce(
      (sum, height) => sum + height,
      0,
    ),
  getItemSize: virtuaSize,
  scrollToIndex: () => {},
}
vi.mock('virtua', async () => {
  const React = await import('react')
  return {
    Virtualizer: ({
      data,
      children,
      ref,
      ...rest
    }: {
      data: unknown[]
      children: (item: unknown, index: number) => unknown
      ref?: React.Ref<unknown>
    }) => {
      React.useImperativeHandle(ref, () => handle)
      virtualizerProps.push(rest)
      return data.map((item, index) =>
        layout.hidden.has(index) ? null : children(item, index),
      )
    },
  }
})
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
  USER_FOLD_EVENT: 'chat:user-fold',
}))

import { useSessionsStore } from '../../stores/sessions'
import { Timeline } from './Timeline'

const message = (
  text: string,
  seq: number,
  fields: Partial<Message> = {},
): Message => ({
  seq,
  sessionId: 'session-1',
  turnId: 'turn-1',
  itemId: 'item-1',
  role: 'agent',
  type: 'text_delta',
  content: { type: 'text_delta', text },
  createdAt: new Date(0).toISOString(),
  ...fields,
})

const FRAME = 1000 / 60
let clock = 0
let frameQueue = new Map<number, FrameRequestCallback>()
let frameId = 0
/** Runs one animation frame, 1/60s later. */
function frame() {
  clock += FRAME
  const callbacks = [...frameQueue.values()]
  frameQueue = new Map()
  for (const callback of callbacks) callback(clock)
}

/**
 * The timeline with browser-like geometry: content height comes from the
 * mocked row heights plus the bottom spacer or the runway's minimum, and
 * `scrollTop` clamps to it.
 */
function mount(props: Parameters<typeof Timeline>[0] = {}) {
  const view = render(<Timeline {...props} />)
  const timeline = view.container.querySelector(
    '.chat-timeline',
  ) as HTMLDivElement
  const content = timeline.firstElementChild as HTMLDivElement
  const box = { clientHeight: 500 }
  // virtua sizes its box from its own sizes, estimates included.
  const scrollHeight = () => {
    const spacer = parseFloat(
      (content.lastElementChild as HTMLElement).style.height || '0',
    )
    const rows = layout.rowHeights.reduce(
      (sum, _, index) => sum + virtuaSize(index),
      0,
    )
    return Math.max(rows + spacer, parseFloat(content.style.minHeight || '0'))
  }
  let top = 0
  // Layout clamps the offset once the content shrinks.
  const clamp = () =>
    (top = Math.min(top, Math.max(0, scrollHeight() - box.clientHeight)))
  Object.defineProperties(timeline, {
    scrollHeight: { get: scrollHeight, configurable: true },
    clientHeight: { get: () => box.clientHeight, configurable: true },
    scrollTop: {
      get: clamp,
      set: (value: number) => {
        top = Math.min(Math.max(0, value), scrollHeight() - box.clientHeight)
      },
      configurable: true,
    },
    getBoundingClientRect: {
      value: () => ({ top: 0, height: box.clientHeight }) as DOMRect,
      configurable: true,
    },
  })
  const max = () => scrollHeight() - box.clientHeight
  const rerender = (next: Parameters<typeof Timeline>[0] = props) =>
    view.rerender(<Timeline {...next} />)
  /** Runs frames and returns `scrollTop` after each. */
  const run = (count: number) =>
    Array.from({ length: count }, () => {
      frame()
      return timeline.scrollTop
    })
  const userScroll = (value: number) => {
    fireEvent.wheel(timeline)
    timeline.scrollTop = value
    fireEvent.scroll(timeline)
  }
  /** Past the window in which the first rows land at once. */
  const land = () => {
    run(1)
    clock += 600
    run(1)
  }
  return { view, timeline, content, box, max, rerender, run, userScroll, land }
}

const increasing = (trace: number[]) =>
  trace.every((value, index) => index === 0 || value >= trace[index - 1])

describe('Timeline', () => {
  beforeEach(() => {
    state.messages = []
    state.pending = []
    layout.rowHeights = []
    useSessionsStore.setState({ sessions: [] })
    clock = 1000
    frameQueue = new Map()
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameId += 1
      frameQueue.set(frameId, callback)
      return frameId
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frameQueue.delete(id))
    layout.estimated = new Set()
    layout.hidden = new Set()
    // Laid-out rows report the mocked heights, in content coordinates.
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        const row = this.dataset.rowIndex
        return row === undefined ? 0 : (layout.rowHeights[Number(row)] ?? 0)
      },
    })
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      writable: true,
      value(this: HTMLElement) {
        const row = this.dataset.rowIndex
        if (row === undefined) return { top: 0, bottom: 0, height: 0 }
        const top = rowOffset(Number(row))
        const height = layout.rowHeights[Number(row)] ?? 0
        return { top, bottom: top + height, height }
      },
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
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
    expect(lastRow(view.container)?.contains(working!)).toBe(true)

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

  const waiting = (status: PendingUserMessage['status']) => {
    state.messages = [message('hello', 1)]
    state.pending = [
      {
        sessionId: 'session-1',
        itemId: 'client_1',
        text: 'hi',
        createdAt: new Date().toISOString(),
        status,
      },
    ]
  }
  /** The rows sit in the content box, before the bottom spacer. */
  const lastRow = (container: HTMLElement) =>
    [...container.querySelector('.chat-timeline > div')!.children].at(-2)

  it('says a prompt is queued while the connection is down', () => {
    waiting('unsent')
    const view = render(<Timeline offline />)
    const working = view.container.querySelector('.chat-working')!
    expect(lastRow(view.container)?.contains(working)).toBe(true)
    expect(screen.getByRole('status').textContent).toContain(
      'Queued, will send automatically',
    )
    // zeron adds no ellipsis and no timer to the queued line.
    expect(working.textContent).not.toMatch(/…|\d+s/)
    expect(working.querySelector('.text-warning')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /retry/ })).toBeNull()
  })

  it('turns an unsent prompt into a retry once the connection is up', () => {
    waiting('unsent')
    const onRetry = vi.fn()
    const view = render(<Timeline onRetry={onRetry} />)
    const working = view.container.querySelector('.chat-working')!
    expect(lastRow(view.container)?.contains(working)).toBe(true)
    const retry = screen.getByRole('button', {
      name: 'Not delivered, click to retry',
    })
    expect(working.contains(retry)).toBe(true)
    expect(retry.className).toContain('text-destructive')
    fireEvent.click(retry)
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('keeps Sending for a prompt the server took while offline', () => {
    waiting('accepted')
    const view = render(<Timeline offline />)
    expect(
      view.container.querySelector('.chat-working')?.textContent,
    ).toContain('Sending…')
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
    it('lands at the end at once when the transcript opens', () => {
      state.messages = [message('hello', 1)]
      layout.rowHeights = [2000]
      const { timeline, run, max } = mount()
      run(1)
      expect(timeline.scrollTop).toBe(max())
      expect(max()).toBe(2000 + 32 - 500)
    })

    it('glides new content in on the spring, without overshoot', () => {
      state.messages = [message('hello', 1)]
      layout.rowHeights = [2000]
      const { timeline, run, max, rerender, land } = mount()
      land()
      const start = timeline.scrollTop
      layout.rowHeights = [2600]
      state.messages = [message('hello world', 2)]
      rerender()
      const trace = run(120)
      // The first frame moves only a little of the 600px; it then eases in
      // and lands exactly on the end.
      expect(trace[0] - start).toBeGreaterThan(0)
      expect(trace[0] - start).toBeLessThan(60)
      expect(increasing(trace)).toBe(true)
      expect(Math.max(...trace)).toBe(max())
      expect(trace.at(-1)).toBe(max())
    })

    it('snaps instead of gliding under reduced motion', () => {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query.includes('reduce'),
      }))
      state.messages = [message('hello', 1)]
      layout.rowHeights = [2000]
      const { timeline, run, max, rerender, land } = mount()
      land()
      layout.rowHeights = [2600]
      state.messages = [message('hello world', 2)]
      rerender()
      run(1)
      expect(timeline.scrollTop).toBe(max())
    })

    it('lets a wheel scroll release the pin and shows the jump pill', () => {
      state.messages = [message('hello', 1)]
      layout.rowHeights = [2000]
      const { timeline, run, rerender, land, userScroll } = mount()
      land()
      userScroll(1000)
      expect(screen.getByRole('button', { name: 'Scroll to bottom' }))
      layout.rowHeights = [2600]
      state.messages = [message('hello again', 2)]
      rerender()
      run(30)
      expect(timeline.scrollTop).toBe(1000)
    })

    it('does not fight a wheel that lands mid-glide', () => {
      state.messages = [message('hello', 1)]
      layout.rowHeights = [2000]
      const { timeline, run, rerender, land } = mount()
      land()
      layout.rowHeights = [2600]
      state.messages = [message('hello world', 2)]
      rerender()
      run(3)
      fireEvent.wheel(timeline)
      const held = timeline.scrollTop
      run(3)
      expect(timeline.scrollTop).toBe(held)
    })

    it('keeps following when content grows without user input', () => {
      state.messages = [message('hello', 1)]
      layout.rowHeights = [2000]
      const { timeline, run, max, rerender, land } = mount()
      land()
      // A scroll event with no input, such as a clamp, keeps the pin.
      fireEvent.scroll(timeline)
      layout.rowHeights = [2300]
      state.messages = [message('hello again', 2)]
      rerender()
      run(120)
      expect(timeline.scrollTop).toBe(max())
      expect(
        screen.queryByRole('button', { name: 'Scroll to bottom' }),
      ).toBeNull()
    })

    it('moves with the composer at once', () => {
      state.messages = [message('hello', 1)]
      layout.rowHeights = [2000]
      const { timeline, max, rerender, land } = mount({ bottomInset: 40 })
      land()
      rerender({ bottomInset: 160 })
      // No frame needed: the last row stays attached to the composer.
      expect(timeline.scrollTop).toBe(max())
      expect(max()).toBe(2000 + 160 + 32 - 500)
    })

    it('glides back from far with the pill, teleporting first', () => {
      state.messages = [message('hello', 1)]
      layout.rowHeights = [10_000]
      const { timeline, run, max, land, userScroll } = mount()
      land()
      userScroll(0)
      fireEvent.click(screen.getByRole('button', { name: 'Scroll to bottom' }))
      clock += 200
      run(1)
      // Within 2.5 viewports of the end after one frame, not at it.
      expect(timeline.scrollTop).toBeGreaterThanOrEqual(max() - 1250)
      expect(timeline.scrollTop).toBeLessThan(max())
      run(120)
      expect(timeline.scrollTop).toBe(max())
    })

    it("follows the rows as laid out, not virtua's estimate", () => {
      state.messages = [message('hello', 1)]
      layout.rowHeights = [2000]
      const { timeline, run, max, rerender, land } = mount()
      land()
      // A 100px row lands; virtua sizes it from its 1200px average first.
      layout.rowHeights = [2000, 100]
      layout.estimated = new Set([1])
      layout.estimate = 1200
      state.messages = [
        message('hello', 1),
        message('next', 2, { itemId: 'item-2' }),
      ]
      rerender()
      const end = 2000 + 100 + 32 - 500
      const trace = run(60)
      expect(Math.max(...trace)).toBe(end)
      expect(trace.at(-1)).toBe(end)
      // virtua measures it: nothing moves.
      layout.estimated = new Set()
      rerender()
      expect(run(10).every((top) => top === end)).toBe(true)
      expect(max()).toBe(end)
    })

    it('releases the pin when a selection drag starts', () => {
      state.messages = [message('hello', 1)]
      layout.rowHeights = [2000]
      const { timeline, run, rerender, land } = mount()
      land()
      const row = timeline.querySelector('[data-transcript-row]')!
      fireEvent.pointerDown(row, { button: 0 })
      vi.spyOn(document, 'getSelection').mockReturnValue({
        isCollapsed: false,
        anchorNode: row,
      } as unknown as Selection)
      document.dispatchEvent(new Event('selectionchange'))
      const before = timeline.scrollTop
      layout.rowHeights = [2600]
      state.messages = [message('hello again', 2)]
      rerender()
      run(30)
      expect(timeline.scrollTop).toBe(before)
    })
  })

  describe('tail floor', () => {
    it('holds the end when the working line leaves before the reply grows', () => {
      state.messages = [message('hello', 1)]
      layout.rowHeights = [2000, 34]
      const { timeline, run, max, rerender, land } = mount({ running: true })
      land()
      const end = timeline.scrollTop
      expect(end).toBe(max())
      // The turn ends. The working line leaves at once; virtua measures the
      // reply's new footer a frame later. Layout clamps the view meanwhile.
      layout.rowHeights = [2000]
      rerender({})
      expect(timeline.scrollTop).toBe(end - 34)
      expect(run(1)).toEqual([end])
      layout.rowHeights = [2032]
      const rest = run(30)
      expect(Math.min(...rest)).toBeGreaterThanOrEqual(end - 2)
      expect(rest.at(-1)).toBe(max())
    })

    it('glides down when the tail stays short', () => {
      state.messages = [message('hello', 1)]
      layout.rowHeights = [2000, 300]
      const { timeline, run, max, rerender, land } = mount({ running: true })
      land()
      const end = timeline.scrollTop
      layout.rowHeights = [2000]
      rerender({})
      const trace = run(60)
      const steps = trace.map(
        (top, index) => (index ? trace[index - 1] : end) - top,
      )
      // It holds for 100ms, then eases down with no step near the full drop.
      expect(trace.slice(0, 5).every((top) => top === end)).toBe(true)
      expect(Math.max(...steps)).toBeLessThan(60)
      expect(steps.every((step) => step >= 0)).toBe(true)
      expect(trace.at(-1)).toBe(max())
    })
  })

  describe('own-send runway', () => {
    const send = () => {
      state.pending = [
        {
          sessionId: 'session-1',
          itemId: 'client_1',
          text: 'next',
          createdAt: new Date().toISOString(),
        },
      ]
    }

    it('glides a sent prompt to the top and holds it while the reply fills in', () => {
      state.messages = [message('hello', 1)]
      layout.rowHeights = [1000]
      const { timeline, content, run, max, rerender, land } = mount({
        running: true,
      })
      land()
      const start = timeline.scrollTop
      expect(start).toBe(1000 + 32 - 500)

      // The prompt and the working line come in; the prompt row is at 1000.
      send()
      layout.rowHeights = [1000, 60, 40]
      rerender()
      // The reservation lets the prompt rest 10px under the viewport top.
      const hold = 1000 - 10
      expect(content.style.minHeight).toBe('')
      const glide = run(40)
      expect(content.style.minHeight).toBe(`${hold + 500 + 2}px`)
      expect(glide[0]).toBeGreaterThan(start)
      expect(glide[0] - start).toBeLessThan((hold - start) * 0.2)
      expect(increasing(glide)).toBe(true)
      expect(glide.at(-1)).toBe(hold)
      expect(
        screen.queryByRole('button', { name: 'Scroll to bottom' }),
      ).toBeNull()

      // The echo replaces the pending bubble and the reply streams in under
      // it. Nothing on screen moves.
      state.pending = []
      state.messages = [
        message('hello', 1),
        message('next', 2, { role: 'user', itemId: 'client_1' }),
        message('reply', 3, { itemId: 'item-3' }),
      ]
      layout.rowHeights = [1000, 60, 200, 40]
      rerender()
      expect(run(20).every((value) => value === hold)).toBe(true)

      // The reply outgrows the reservation: tail-follow takes over and
      // glides on from the hold.
      layout.rowHeights = [1000, 60, 560, 40]
      state.messages = [
        ...state.messages.slice(0, 2),
        message('reply grows', 4, { itemId: 'item-3' }),
      ]
      rerender()
      const follow = run(120)
      expect(content.style.minHeight).toBe('')
      expect(increasing(follow)).toBe(true)
      expect(follow[0]).toBeLessThan(max())
      expect(follow.at(-1)).toBe(max())
    })

    it("holds the runway while a fresh row is only virtua's estimate", () => {
      state.messages = [message('hello', 1)]
      layout.rowHeights = [1000]
      const { timeline, content, run, rerender, land } = mount({
        running: true,
      })
      land()
      send()
      // The working line is not rendered yet; virtua guesses 900px for it.
      layout.rowHeights = [1000, 60, 40]
      layout.estimated = new Set([2])
      layout.hidden = new Set([2])
      layout.estimate = 900
      rerender()
      run(40)
      expect(content.style.minHeight).not.toBe('')
      expect(timeline.scrollTop).toBe(990)
    })

    it('gives the view back to the wheel and re-arms at the bottom', () => {
      state.messages = [message('hello', 1)]
      layout.rowHeights = [1000]
      const { timeline, run, rerender, land, userScroll } = mount({
        running: true,
      })
      land()
      send()
      layout.rowHeights = [1000, 60, 40]
      rerender()
      run(40)
      expect(timeline.scrollTop).toBe(990)
      userScroll(600)
      run(20)
      expect(timeline.scrollTop).toBe(600)
      // Back at the bottom, the hold takes over again.
      userScroll(992)
      clock += 200
      run(40)
      expect(timeline.scrollTop).toBe(990)
    })
  })

  describe('prompt fold', () => {
    it('stops the follow and glides the row under the top fade', () => {
      state.messages = [
        message('hello', 1),
        message('prompt', 2, { role: 'user', itemId: 'u' }),
        message('reply', 3, { itemId: 'r' }),
      ]
      layout.rowHeights = [2000, 400, 800]
      const { timeline, run, rerender, land } = mount()
      land()
      const rows = timeline.querySelectorAll('[data-transcript-row]')
      const row = rows[1] as HTMLElement
      // The prompt row starts 2000px down the content.
      row.getBoundingClientRect = () =>
        ({ top: 2000 - timeline.scrollTop, height: 400 }) as DOMRect
      timeline.scrollTop = 2200
      row.dispatchEvent(
        new CustomEvent('chat:user-fold', {
          bubbles: true,
          detail: { heightChange: -268, heightDelta: 290 },
        }),
      )
      const trace = run(40).map((top) => 2000 - top)
      // The row top eases from -200px into the band 52px down.
      expect(trace[0]).toBeGreaterThan(-200)
      expect(trace.at(-1)).toBe(52)
      expect(increasing(trace)).toBe(true)
      // Folding broke the follow: growth no longer moves the view.
      const before = timeline.scrollTop
      layout.rowHeights = [2000, 400, 1400]
      state.messages = [
        ...state.messages.slice(0, 2),
        message('reply grows', 4, { itemId: 'r' }),
      ]
      rerender()
      run(30)
      expect(timeline.scrollTop).toBe(before)
    })
  })
})
