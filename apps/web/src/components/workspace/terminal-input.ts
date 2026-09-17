import { terminalInputOutcomeSchema } from '@forge/protocol/terminal'

const limit = 65536
export function terminalInputQueue(
  endpoint: string,
  report: (message: string) => void,
  fetcher = fetch,
) {
  const queue: Array<{ path: string; body: unknown; bytes: number }> = []
  const controller = new AbortController()
  let pendingResize: { cols: number; rows: number } | undefined
  let bytes = 0,
    running = false,
    closed = false
  const drain = async () => {
    if (running || closed) return
    running = true
    try {
      while ((queue.length || pendingResize) && !closed) {
        if (!queue.length && pendingResize) {
          queue.push({ path: 'resize', body: pendingResize, bytes: 0 })
          pendingResize = undefined
        }
        const item = queue[0]
        const response = await fetcher(`${endpoint}/${item.path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(item.body),
          signal: controller.signal,
        })
        if (!response.ok) {
          await response.body?.cancel()
          throw Error(`Terminal ${item.path} failed (${response.status})`)
        }
        if (item.path === 'input') {
          const result = terminalInputOutcomeSchema.parse(await response.json())
          if (result.status !== 'written' || result.writtenBytes !== item.bytes)
            throw Error(
              'Terminal input was not fully written. It was not retried.',
            )
        } else await response.body?.cancel()
        queue.shift()
        bytes -= item.bytes
      }
    } catch (error) {
      if (!closed)
        report(error instanceof Error ? error.message : 'Terminal input failed')
      closed = true
    } finally {
      running = false
      if (closed) {
        queue.length = 0
        pendingResize = undefined
        bytes = 0
      }
    }
  }
  const enqueue = (path: string, body: unknown, size: number) => {
    if (closed) return false
    if (queue.length >= 64 || bytes + size > limit) {
      report('Terminal input queue is full. Wait before sending more input.')
      return false
    }
    queue.push({ path, body, bytes: size })
    bytes += size
    void drain()
    return true
  }
  return {
    input(text: string, binary = false) {
      if (text.length > limit) {
        report('Terminal paste exceeds 64 KiB.')
        return false
      }
      const data = binary
        ? Uint8Array.from(text, (character) => character.charCodeAt(0) & 255)
        : new TextEncoder().encode(text)
      if (data.byteLength > limit) {
        report('Terminal paste exceeds 64 KiB.')
        return false
      }
      let encoded = ''
      for (const byte of data) encoded += String.fromCharCode(byte)
      return enqueue('input', { data: btoa(encoded) }, data.byteLength)
    },
    resize(cols: number, rows: number) {
      if (closed) return false
      pendingResize = { cols, rows }
      void drain()
      return true
    },
    close() {
      closed = true
      controller.abort()
      if (!running) {
        queue.length = 0
        pendingResize = undefined
        bytes = 0
      }
    },
  }
}
