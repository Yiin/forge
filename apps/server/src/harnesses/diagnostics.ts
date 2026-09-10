import { StringDecoder } from 'node:string_decoder'

export function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`Invalid ${name} limit`)
  return value
}

export function redactSecrets(value: string, secrets: readonly string[] = []) {
  return [...secrets]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .reduce((text, secret) => text.split(secret).join('[REDACTED]'), value)
}

/** Keep a valid UTF-8 tail within the byte limit. */
export function byteTail(value: string, limit: number): string {
  const bytes = Buffer.from(value)
  let start = Math.max(0, bytes.length - limit)
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++
  return bytes.subarray(start).toString('utf8')
}

export function diagnosticError(
  value: unknown,
  secrets: readonly string[] = [],
  limit = 4096,
): Error {
  const message =
    value instanceof Error ? value.message : 'Native operation failed'
  return new Error(byteTail(redactSecrets(message, secrets), limit))
}

/** Redact before truncating, including secrets split across stderr chunks. */
export class DiagnosticTail {
  private readonly decoder = new StringDecoder('utf8')
  private readonly secrets: string[]
  private pending = ''
  private tail = ''
  private ended = false

  constructor(
    private readonly limit = 64 * 1024,
    secrets: readonly string[] = [],
  ) {
    positiveLimit(limit, 'diagnostic bytes')
    this.secrets = [...secrets]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
  }

  get text() {
    return this.tail
  }

  append(chunk: Uint8Array) {
    if (this.ended) return
    // Bound temporary strings even when a caller supplies a large chunk.
    for (let offset = 0; offset < chunk.length; offset += 4096) {
      this.pending += this.decoder.write(
        Buffer.from(chunk.subarray(offset, offset + 4096)),
      )
      this.flush(false)
    }
  }

  finish() {
    if (this.ended) return
    this.ended = true
    this.pending += this.decoder.end()
    this.flush(true)
  }

  private flush(final: boolean) {
    let output = ''
    let offset = 0
    while (offset < this.pending.length) {
      const rest = this.pending.slice(offset)
      if (
        this.secrets.some(
          (secret) => secret.length > rest.length && secret.startsWith(rest),
        )
      ) {
        // Hold shorter complete matches until a longer secret is ruled out.
        if (final) {
          output += '[REDACTED]'
          offset = this.pending.length
        }
        break
      }
      const match = this.secrets.find((secret) => rest.startsWith(secret))
      if (match) {
        output += '[REDACTED]'
        offset += match.length
      } else {
        const point = this.pending.codePointAt(offset)!
        const char = String.fromCodePoint(point)
        output += char
        offset += char.length
      }
    }
    this.pending = this.pending.slice(offset)
    this.tail = byteTail(this.tail + output, this.limit)
  }
}
