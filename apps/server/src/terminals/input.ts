import type { TerminalInputOutcome } from '@forge/protocol/terminal'
import { TerminalError } from './error.js'
import type { LinuxPty } from './linux-pty.js'
import type { TerminalLimitValues } from './limits.js'

type Input = {
  bytes: Buffer
  offset: number
  deadline: number
  owner: InputOwner
  resolve: (outcome: TerminalInputOutcome) => void
  signal?: AbortSignal
  abort?: () => void
}
export type InputOwner = {
  native: LinuxPty | null
  input: Input[]
  inputBytes: number
  acceptingInput: boolean
}
export function base64Size(value: string, limit: number) {
  if (
    value.length > Math.ceil(limit / 3) * 4 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new TerminalError(
      'invalid_request',
      400,
      'Input must use canonical base64',
    )
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const size = (value.length / 4) * 3 - padding
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  if (
    size > limit ||
    (padding === 2 &&
      (alphabet.indexOf(value[value.length - 3]!) & 15) !== 0) ||
    (padding === 1 && (alphabet.indexOf(value[value.length - 2]!) & 3) !== 0)
  )
    throw new TerminalError(
      'invalid_request',
      400,
      'Input must use canonical base64',
    )
  return size
}
export class TerminalInputScheduler {
  private readonly owners = new Set<InputOwner>()
  private bytes = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  constructor(private readonly limits: Readonly<TerminalLimitValues>) {}
  submit(owner: InputOwner, encoded: string, signal?: AbortSignal) {
    const size = base64Size(encoded, this.limits.inputBytes)
    if (this.stopped || !owner.acceptingInput || !owner.native)
      throw new TerminalError('unavailable', 503, 'Terminal input is closed')
    if (
      owner.input.length >= this.limits.inputItems ||
      owner.inputBytes + size > this.limits.inputQueueBytes ||
      this.bytes + size > this.limits.hostInputBytes
    )
      throw new TerminalError(
        'capacity',
        429,
        'Terminal input capacity reached',
      )
    // Charge before decoding or allocating the admitted input closure.
    owner.inputBytes += size
    this.bytes += size
    let bytes: Buffer
    try {
      bytes = Buffer.from(encoded, 'base64')
    } catch (error) {
      owner.inputBytes -= size
      this.bytes -= size
      throw error
    }
    return new Promise<TerminalInputOutcome>((resolve) => {
      const input: Input = {
        bytes,
        offset: 0,
        deadline: performance.now() + this.limits.inputDeadlineMs,
        owner,
        resolve,
        signal,
      }
      input.abort = () => this.finish(input, 'cancelled')
      owner.input.push(input)
      this.owners.add(owner)
      signal?.addEventListener('abort', input.abort, { once: true })
      if (signal?.aborted) this.finish(input, 'cancelled')
      else if (size === 0) this.finish(input, 'written')
      else this.schedule(0)
    })
  }
  close(owner: InputOwner) {
    owner.acceptingInput = false
    for (const input of [...owner.input]) this.finish(input, 'closed')
  }
  stop() {
    this.stopped = true
    for (const owner of [...this.owners]) this.close(owner)
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }
  get retainedBytes() {
    return this.bytes
  }
  private finish(input: Input, status: TerminalInputOutcome['status']) {
    const at = input.owner.input.indexOf(input)
    if (at < 0) return
    input.owner.input.splice(at, 1)
    input.owner.inputBytes -= input.bytes.length
    this.bytes -= input.bytes.length
    if (!input.owner.input.length) this.owners.delete(input.owner)
    if (input.abort) input.signal?.removeEventListener('abort', input.abort)
    input.resolve({
      requestedBytes: input.bytes.length,
      writtenBytes: input.offset,
      status,
    })
    if (!this.owners.size && this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }
  private schedule(ms: number) {
    if (!this.timer && this.owners.size)
      this.timer = setTimeout(() => {
        this.timer = undefined
        this.tick()
      }, ms)
  }
  private tick() {
    let hostBudget = this.limits.hostTickBytes
    let blocked = false
    for (const owner of this.owners) {
      let ownerBudget = Math.min(this.limits.terminalTickBytes, hostBudget)
      while (owner.input.length && ownerBudget > 0) {
        const input = owner.input[0]!
        if (performance.now() >= input.deadline) {
          this.finish(input, 'timed_out')
          continue
        }
        if (!owner.acceptingInput || !owner.native) {
          this.finish(input, 'closed')
          continue
        }
        try {
          const count = Math.min(
            input.bytes.length - input.offset,
            ownerBudget,
            this.limits.syscallBytes,
          )
          const written = owner.native.write(input.bytes, input.offset, count)
          input.offset += written
          ownerBudget -= written
          hostBudget -= written
          if (input.offset === input.bytes.length) this.finish(input, 'written')
          else if (written === 0) {
            blocked = true
            break
          }
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code === 'EAGAIN' ||
            (error as NodeJS.ErrnoException).code === 'EWOULDBLOCK'
          ) {
            blocked = true
            break
          }
          this.finish(
            input,
            owner.native.checkMaster() ? 'write_failed' : 'closed',
          )
        }
      }
      if (hostBudget <= 0) {
        // Move the last writer behind its peers for the next host tick.
        this.owners.delete(owner)
        if (owner.input.length) this.owners.add(owner)
        break
      }
    }
    this.schedule(blocked ? this.limits.inputRetryMs : 0)
  }
}
