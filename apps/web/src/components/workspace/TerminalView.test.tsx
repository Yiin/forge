// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TerminalView } from './TerminalView'

const state = vi.hoisted(() => ({
  writes: [] as Array<{ bytes: Uint8Array; done: () => void }>,
  dispose: vi.fn(),
  input: undefined as undefined | ((text: string) => void),
  fits: vi.fn(),
  resize: vi.fn(),
  cols: 81,
  rows: 27,
  disconnect: vi.fn(),
}))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = state.cols
    rows = state.rows
    resize = state.resize
    loadAddon() {}
    open() {}
    focus() {}
    reset() {}
    onData(callback: (text: string) => void) {
      state.input = callback
      return { dispose: vi.fn() }
    }
    onBinary() {
      return { dispose: vi.fn() }
    }
    write(bytes: Uint8Array, done: () => void) {
      state.writes.push({ bytes, done })
    }
    dispose = state.dispose
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = state.fits
  },
}))

const epoch = '12345678-1234-4234-8234-123456789abc'
const id = `${epoch}.${epoch}`
class Socket {
  static all: Socket[] = []
  onmessage?: (event: { data: string }) => void
  onclose?: () => void
  close = vi.fn()
  constructor(readonly url: string) {
    Socket.all.push(this)
  }
  data(seq: number, bytes: number[] = [27, 91, 50, 74]) {
    this.onmessage?.({
      data: JSON.stringify({
        type: 'data',
        terminalId: id,
        seq,
        data: btoa(String.fromCharCode(...bytes)),
      }),
    })
  }
}
function mount(onError = vi.fn(), onClearError = vi.fn()) {
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect = state.disconnect
    },
  )
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  return render(
    <TerminalView
      sessionId="s"
      terminal={{ id, state: 'running' } as any}
      onDescriptor={vi.fn()}
      onError={onError}
      onClearError={onClearError}
    />,
  )
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  Socket.all = []
  state.writes = []
  state.cols = 81
  state.rows = 27
  vi.clearAllMocks()
})

it('keeps raw UTF-8 and ANSI bytes intact and resumes only acknowledged output', async () => {
  vi.useFakeTimers()
  mount()
  Socket.all[0].data(1, [0xe2, 0x82])
  Socket.all[0].data(2, [0xac, 27, 91, 50, 74])
  expect(state.writes).toHaveLength(1)
  expect([...state.writes[0].bytes]).toEqual([0xe2, 0x82])
  Socket.all[0].onclose?.()
  await vi.advanceTimersByTimeAsync(500)
  expect(Socket.all).toHaveLength(1)
  act(() => state.writes[0].done())
  expect([...state.writes[1].bytes]).toEqual([0xac, 27, 91, 50, 74])
  act(() => state.writes[1].done())
  await vi.advanceTimersByTimeAsync(20)
  expect(Socket.all[1].url).toContain('afterSeq=2')
  Socket.all[1].data(2)
  expect(state.writes).toHaveLength(2)
})

it('disposes the original view on hide and starts a fresh emulator with cursor zero on reopen', () => {
  const first = mount()
  Socket.all[0].data(1)
  first.unmount()
  expect(Socket.all[0].close).toHaveBeenCalledOnce()
  expect(state.dispose).toHaveBeenCalledOnce()
  act(() => state.writes[0].done())
  mount()
  expect(Socket.all[1].url).toContain('afterSeq=0')
})

it('closes output admission when held parser work reaches its frame bound', () => {
  mount()
  for (let seq = 1; seq <= 129; seq++) Socket.all[0].data(seq)
  expect(Socket.all[0].close).toHaveBeenCalledOnce()
  expect(state.writes).toHaveLength(1)
})

it('posts fitted dimensions and disposes the original resize observer', () => {
  const fetcher = vi.fn(async () => new Response('{}'))
  vi.stubGlobal('fetch', fetcher)
  const view = mount()
  const host = view.getByLabelText('Terminal emulator')
  Object.defineProperties(host, {
    clientWidth: { value: 800 },
    clientHeight: { value: 400 },
  })
  const callback = vi.mocked(requestAnimationFrame).mock.calls[0][0]
  act(() => callback(0))
  expect(state.fits).toHaveBeenCalledOnce()
  expect(fetcher).toHaveBeenCalledWith(
    expect.stringContaining('/resize'),
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ cols: 81, rows: 27 }),
    }),
  )
  view.unmount()
  expect(cancelAnimationFrame).toHaveBeenCalled()
  expect(state.disconnect).toHaveBeenCalledOnce()
})

it('drains the acknowledged prefix before replaying an overflow suffix exactly once', async () => {
  vi.useFakeTimers()
  mount()
  for (let seq = 1; seq <= 150; seq++) Socket.all[0].data(seq, [seq])
  expect(Socket.all[0].close).toHaveBeenCalledOnce()
  Socket.all[0].onclose?.()
  await vi.advanceTimersByTimeAsync(500)
  expect(Socket.all).toHaveLength(1)
  for (let index = 0; index < 128; index++)
    act(() => state.writes[index].done())
  await vi.advanceTimersByTimeAsync(20)
  expect(Socket.all[1].url).toContain('afterSeq=128')
  for (let seq = 129; seq <= 150; seq++) Socket.all[1].data(seq, [seq])
  for (let index = 128; index < 150; index++)
    act(() => state.writes[index].done())
  expect(state.writes.map((item) => item.bytes[0])).toEqual(
    Array.from({ length: 150 }, (_, index) => index + 1),
  )
})
it('clamps the emulator itself to the server dimension limit', () => {
  state.cols = 900
  state.rows = 700
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}')),
  )
  const view = mount()
  Object.defineProperties(view.getByLabelText('Terminal emulator'), {
    clientWidth: { value: 8000 },
    clientHeight: { value: 4000 },
  })
  act(() => vi.mocked(requestAnimationFrame).mock.calls[0][0](0))
  expect(state.resize).toHaveBeenCalledWith(500, 300)
})

it.each([false, true])(
  'keeps running resize errors but retires an exited original request: exited=%s',
  async (exited) => {
    let settle!: (response: Response) => void
    const fetcher = vi.fn(
      (_url: unknown, _init: RequestInit) =>
        new Promise<Response>((resolve) => {
          settle = resolve
        }),
    )
    vi.stubGlobal('fetch', fetcher)
    const onError = vi.fn()
    const view = mount(onError)
    Object.defineProperties(view.getByLabelText('Terminal emulator'), {
      clientWidth: { value: 800 },
      clientHeight: { value: 400 },
    })
    act(() => vi.mocked(requestAnimationFrame).mock.calls[0][0](0))
    expect(fetcher).toHaveBeenCalledTimes(1)
    if (exited)
      act(() =>
        Socket.all[0].onmessage?.({
          data: JSON.stringify({
            type: 'exit',
            terminalId: id,
            seq: 1,
            exitCode: 0,
            signal: null,
            outputComplete: true,
            cleanup: 'complete',
            reason: 'exited',
          }),
        }),
      )
    await act(async () => {
      settle(new Response('{}', { status: 503 }))
    })
    if (exited) {
      expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true)
      expect(onError).not.toHaveBeenCalled()
      act(() => state.input?.('late input'))
      expect(fetcher).toHaveBeenCalledTimes(1)
    } else expect(onError).toHaveBeenCalledWith('Terminal resize failed (503)')
  },
)

it('fits retained output after exit without sending a new resize', () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  const view = mount()
  Object.defineProperties(view.getByLabelText('Terminal emulator'), {
    clientWidth: { value: 800 },
    clientHeight: { value: 400 },
  })
  act(() =>
    Socket.all[0].onmessage?.({
      data: JSON.stringify({
        type: 'exit',
        terminalId: id,
        seq: 1,
        exitCode: 0,
        signal: null,
        outputComplete: true,
        cleanup: 'complete',
        reason: 'exited',
      }),
    }),
  )
  act(() => vi.mocked(requestAnimationFrame).mock.calls[0][0](0))
  expect(state.fits).toHaveBeenCalledOnce()
  expect(fetcher).not.toHaveBeenCalled()
})

it('clears only its reported resize error when original exit arrives later', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 503 })),
  )
  const onError = vi.fn(),
    onClearError = vi.fn()
  const view = mount(onError, onClearError)
  Object.defineProperties(view.getByLabelText('Terminal emulator'), {
    clientWidth: { value: 800 },
    clientHeight: { value: 400 },
  })
  await act(async () => vi.mocked(requestAnimationFrame).mock.calls[0][0](0))
  expect(onError).toHaveBeenCalledWith('Terminal resize failed (503)')
  expect(onClearError).not.toHaveBeenCalled()
  act(() =>
    Socket.all[0].onmessage?.({
      data: JSON.stringify({
        type: 'exit',
        terminalId: id,
        seq: 1,
        exitCode: 0,
        signal: null,
        outputComplete: true,
        cleanup: 'complete',
        reason: 'exited',
      }),
    }),
  )
  expect(onClearError).toHaveBeenCalledExactlyOnceWith(
    'Terminal resize failed (503)',
  )
})
