import { spawn, type IPty } from 'node-pty'
import stripAnsi from 'strip-ansi'
import type { HarnessConfig } from '@forge/protocol/config'
import type {
  HarnessHandle,
  HarnessItem,
  HarnessProcess,
  HarnessSession,
} from '../sessions/harness.js'

type PtyOptions = Pick<HarnessConfig, 'command' | 'args' | 'env'> &
  Partial<Pick<HarnessConfig, 'quietPeriodMs' | 'maxTurnMs'>>

// PTYs use OSC and CSI sequences for prompts, colours, and cursor movement.
// strip-ansi handles standard sequences. This catches incomplete OSC frames.
export function cleanPtyText(value: string) {
  return stripAnsi(value)
    .replace(/\u001b\][^\u0007]*(?:\u0007|$)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

function withoutEcho(text: string, prompt: string) {
  if (!prompt) return text
  const firstLine = text.split('\n', 1)[0] ?? ''
  const marker = firstLine.match(/[$#>] /)
  const echoed = marker
    ? firstLine.slice((marker.index ?? 0) + marker[0].length)
    : prompt
  const index = text.indexOf(echoed || prompt)
  if (index < 0) return text
  return text.slice(0, index) + text.slice(index + (echoed || prompt).length)
}

function withoutShellPrompts(text: string) {
  return text
    .split('\n')
    .filter((line) => !/^(?:[^\n]*)(?:[$#>] )$/.test(line))
    .join('\n')
}

function removeEchoLine(text: string, prompt: string) {
  return text
    .split('\n')
    .filter((line) => !(line.includes(prompt) && /[$#>] /.test(line)))
    .join('\n')
}

export function createPtyHarness(options: PtyOptions): HarnessProcess {
  const quietPeriodMs = options.quietPeriodMs ?? 2000
  const maxTurnMs = options.maxTurnMs ?? 30 * 60 * 1000

  return {
    capabilities: { loadSession: false },
    spawn(
      session: HarnessSession,
      onItem: (item: HarnessItem) => void,
      onExit,
    ) {
      let pty: IPty
      try {
        pty = spawn(options.command, options.args, {
          name: 'xterm-256color',
          cols: 200,
          rows: 50,
          cwd: session.cwd,
          env: { ...process.env, ...options.env } as Record<string, string>,
        })
      } catch (error) {
        onExit(error instanceof Error ? error : new Error(String(error)))
        throw error
      }

      let active = false
      let received = false
      let interrupted = false
      let promptText = ''
      let output = ''
      let turnStart = 0
      let quietTimer: ReturnType<typeof setTimeout> | undefined
      let maxTimer: ReturnType<typeof setTimeout> | undefined

      const clearTimers = () => {
        if (quietTimer) clearTimeout(quietTimer)
        if (maxTimer) clearTimeout(maxTimer)
        quietTimer = undefined
        maxTimer = undefined
      }
      const emit = (item: HarnessItem) => onItem(item)
      const flush = () => {
        const turnOutput = output.slice(turnStart)
        // console.log({ promptText, turnOutput })
        const text = removeEchoLine(
          withoutShellPrompts(withoutEcho(turnOutput, promptText)),
          promptText,
        ).trim()
        for (let offset = 0; offset < text.length; offset += 2048)
          emit({ type: 'text_delta', text: text.slice(offset, offset + 2048) })
      }
      const finish = (
        type: 'turn_end' | 'turn_interrupted',
        reason?: string,
      ) => {
        if (!active) return
        clearTimers()
        flush()
        active = false
        emit(
          type === 'turn_end'
            ? { type: 'turn_end' }
            : { type: 'turn_interrupted', ...(reason ? { reason } : {}) },
        )
      }
      const quietFinish = () => {
        if (active && received) finish('turn_end')
      }
      const armQuietTimer = () => {
        if (quietTimer) clearTimeout(quietTimer)
        quietTimer = setTimeout(quietFinish, quietPeriodMs)
      }
      const onData = (chunk: string) => {
        if (!active) return
        const clean = cleanPtyText(chunk)
        if (!clean) return
        received = true
        output += clean
        const turnOutput = output.slice(turnStart)
        const commandStart = turnOutput.lastIndexOf(promptText)
        const commandEnd = commandStart + promptText.length
        const promptStart = Math.max(
          turnOutput.lastIndexOf('$ '),
          turnOutput.lastIndexOf('# '),
          turnOutput.lastIndexOf('> '),
        )
        if (
          commandStart >= 0 &&
          promptStart > commandEnd &&
          turnOutput.lastIndexOf('\n') > commandEnd
        )
          armQuietTimer()
      }
      const exit = (event: { exitCode: number }) => {
        clearTimers()
        if (active && !interrupted) {
          emit({
            type: 'error',
            message: 'PTY process exited',
            code: String(event.exitCode),
          })
          finish('turn_interrupted', 'pty_process_died')
        }
        onExit(new Error(`PTY process exited with code ${event.exitCode}`))
      }
      pty.onData(onData)
      pty.onExit(exit)

      const handle: HarnessHandle = {
        prompt(text) {
          if (active) throw new Error('PTY turn already running')
          active = true
          received = false
          interrupted = false
          turnStart = output.length
          promptText = text
          emit({ type: 'turn_start' })
          pty.write(`${text}\r`)
          maxTimer = setTimeout(
            () => finish('turn_interrupted', 'max_turn_time'),
            maxTurnMs,
          )
        },
        cancel() {
          if (!active) return
          interrupted = true
          pty.write('\u0003')
          finish('turn_interrupted', 'cancelled')
        },
        kill() {
          clearTimers()
          active = false
          pty.kill()
        },
      }
      return handle
    },
  }
}

export const ptyHarness = (entry: HarnessConfig) => createPtyHarness(entry)
