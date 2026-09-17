import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {
  terminalEventSchema,
  type TerminalDescriptor,
} from '@forge/protocol/terminal'
import { terminalInputQueue } from './terminal-input'

export function TerminalView({
  sessionId,
  terminal,
  onDescriptor,
  onError,
  onClearError,
}: {
  sessionId: string
  terminal: TerminalDescriptor
  onDescriptor: (value: TerminalDescriptor) => void
  onError: (message: string) => void
  onClearError: (message: string) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const callbacks = useRef({ onDescriptor, onError, onClearError, terminal })
  callbacks.current = { onDescriptor, onError, onClearError, terminal }
  useEffect(() => {
    if (!host.current) return
    const endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/terminals/${encodeURIComponent(terminal.id)}`
    const emulator = new Terminal({
      scrollback: 2000,
      convertEol: false,
      fontSize: 13,
      screenReaderMode: true,
      theme: { background: '#000000', foreground: '#eeeeee' },
    })
    const fit = new FitAddon()
    emulator.loadAddon(fit)
    emulator.open(host.current)
    let resizeError: string | undefined
    const input = terminalInputQueue(endpoint, (message) => {
      if (message === 'Terminal resize failed (503)') resizeError = message
      callbacks.current.onError(message)
    })
    const retireInput = () => {
      input.close()
      if (resizeError && terminalState === 'exited') {
        callbacks.current.onClearError(resizeError)
        resizeError = undefined
      }
    }
    let stopped = false,
      socket: WebSocket | undefined,
      retry: ReturnType<typeof setTimeout> | undefined
    let animation = 0,
      cursor = 0,
      received = 0,
      pendingBytes = 0,
      writing = false,
      overflow = false
    let attempts = 0
    let ended = false,
      exitSeq = 0
    let terminalState = terminal.state
    const pending: Array<{ seq: number; bytes: Uint8Array }> = []
    const dimensions = { cols: 0, rows: 0 }
    const measure = () => {
      cancelAnimationFrame(animation)
      animation = requestAnimationFrame(() => {
        if (stopped || !host.current?.clientWidth || !host.current.clientHeight)
          return
        fit.fit()
        const cols = Math.min(500, Math.max(2, emulator.cols)),
          rows = Math.min(300, Math.max(1, emulator.rows))
        if (emulator.cols !== cols || emulator.rows !== rows)
          emulator.resize(cols, rows)
        if (
          terminalState === 'running' &&
          (cols !== dimensions.cols || rows !== dimensions.rows)
        ) {
          if (input.resize(cols, rows)) {
            dimensions.cols = cols
            dimensions.rows = rows
          }
        }
      })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(host.current)
    const send = (text: string, binary = false) => {
      if (terminalState !== 'running') return
      input.input(text, binary)
    }
    const data = emulator.onData((text) => send(text))
    const binary = emulator.onBinary((text) => send(text, true))
    const drain = () => {
      if (stopped || writing || !pending.length) return
      const item = pending[0]
      writing = true
      emulator.write(item.bytes, () => {
        if (stopped) return
        cursor = item.seq
        pendingBytes -= item.bytes.byteLength
        pending.shift()
        if (!pending.length && exitSeq) cursor = exitSeq
        writing = false
        drain()
      })
    }
    const connect = () => {
      if (stopped || overflow) return
      // Wait for original parser callbacks before choosing the replay cursor.
      if (writing || pending.length) {
        retry = setTimeout(connect, 20)
        return
      }
      received = cursor
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const current = new WebSocket(
        `${protocol}//${location.host}${endpoint}/events?afterSeq=${cursor}`,
      )
      socket = current
      current.onmessage = (message) => {
        if (stopped || socket !== current) return
        try {
          if (
            typeof message.data !== 'string' ||
            message.data.length > 2 * 1024 * 1024
          )
            throw Error('Terminal output frame exceeds its limit.')
          const event = terminalEventSchema.parse(JSON.parse(message.data))
          if (event.type === 'snapshot') {
            if (
              event.descriptor.id !== terminal.id ||
              event.descriptor.sessionId !== sessionId
            )
              throw Error('Terminal replay owner changed.')
            terminalState = event.descriptor.state
            if (terminalState === 'running') measure()
            else if (terminalState !== 'starting') retireInput()
            callbacks.current.onDescriptor(event.descriptor)
            if (event.replayGap) {
              callbacks.current.onError(
                'Earlier terminal output expired. Showing retained output.',
              )
              emulator.reset()
              cursor = event.replayGap.toSeq
              received = cursor
            }
            return
          }
          if (event.terminalId !== terminal.id || event.seq <= received) return
          if (event.seq !== received + 1)
            throw Error(
              'Terminal output sequence is incomplete. Reconnect to retry.',
            )
          if (event.type === 'data') {
            if (event.data.length > 1400000)
              throw Error('Terminal output frame exceeds its limit.')
            const binary = atob(event.data)
            if (
              pending.length >= 128 ||
              pendingBytes + binary.length > 1024 * 1024
            ) {
              // Keep the emulator and acknowledged cursor. The rejected suffix
              // stays in the server ring until this parser drains and reconnects.
              current.onmessage = null
              current.close()
              return
            }
            const bytes = Uint8Array.from(binary, (character) =>
              character.charCodeAt(0),
            )
            pendingBytes += bytes.byteLength
            pending.push({ seq: event.seq, bytes })
            received = event.seq
            drain()
          } else {
            received = event.seq
            ended = true
            terminalState = 'exited'
            retireInput()
            exitSeq = event.seq
            if (!pending.length) cursor = exitSeq
            callbacks.current.onDescriptor({
              ...callbacks.current.terminal,
              state: 'exited',
              exitCode: event.exitCode,
              signal: event.signal,
              outputComplete: event.outputComplete,
              cleanup: event.cleanup,
            })
          }
        } catch (error) {
          overflow = true
          callbacks.current.onError(
            error instanceof Error ? error.message : 'Terminal output failed',
          )
          current.close()
        }
      }
      current.onclose = () => {
        if (stopped || socket !== current || overflow || ended) return
        if (++attempts > 8) {
          callbacks.current.onError(
            'Terminal connection closed. Reconnect to retry.',
          )
          return
        }
        retry = setTimeout(connect, Math.min(5000, 100 * 2 ** attempts))
      }
    }
    connect()
    measure()
    emulator.focus()
    return () => {
      stopped = true
      clearTimeout(retry)
      cancelAnimationFrame(animation)
      socket?.close()
      observer.disconnect()
      data.dispose()
      binary.dispose()
      input.close()
      emulator.dispose()
      pending.length = 0
    }
  }, [sessionId, terminal.id])
  return (
    <div
      ref={host}
      className="min-h-0 min-w-0 flex-1 overflow-hidden bg-black p-2"
      aria-label="Terminal emulator"
    />
  )
}
