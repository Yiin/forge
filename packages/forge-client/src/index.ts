import {
  HealthResponse,
  StatusEvent,
  StatusResponse,
} from './generated/status.js'

export type { HealthResponse, StatusEvent, StatusResponse }

export type ForgeClient = ReturnType<typeof createForgeClient>

type EventSourceLike = {
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((...args: any[]) => void) | null
  addEventListener?: (
    type: string,
    listener: (event: MessageEvent) => void,
  ) => void
  close: () => void
}

const eventSourceConstructor = () =>
  (
    globalThis as typeof globalThis & {
      EventSource?: new (url: string) => EventSourceLike
    }
  ).EventSource

export function createForgeClient(baseUrl: string) {
  const root = baseUrl.replace(/\/$/, '')
  const request = async <T>(
    path: string,
    schema: { parse: (value: unknown) => T },
  ) => {
    const response = await fetch(`${root}${path}`)
    if (!response.ok)
      throw new Error(`Forge request failed: ${response.status}`)
    return schema.parse(await response.json())
  }

  return {
    health: () => request('/api/health', HealthResponse),
    status: () => request('/api/status', StatusResponse),
    events(
      onEvent: (event: StatusEvent) => void,
      options: { signal?: AbortSignal } = {},
    ) {
      const signal = options.signal
      let stopped = false
      let retryTimer: ReturnType<typeof setTimeout> | undefined
      let source: EventSourceLike | undefined
      let controller: AbortController | undefined
      let retry = 0

      const stop = () => {
        stopped = true
        if (retryTimer) clearTimeout(retryTimer)
        controller?.abort()
        source?.close()
      }
      signal?.addEventListener('abort', stop, { once: true })

      const reconnect = () => {
        if (stopped) return
        const delay = Math.min(5_000, 100 * 2 ** retry++) + Math.random() * 100
        retryTimer = setTimeout(connect, delay)
      }
      const emit = (value: unknown) => onEvent(StatusEvent.parse(value))

      const connectWithEventSource = () => {
        const EventSource = eventSourceConstructor()!
        const nextSource = new EventSource(`${root}/api/events`)
        source = nextSource
        const handleMessage = (event: MessageEvent) => {
          retry = 0
          emit(JSON.parse(event.data))
        }
        nextSource.onmessage = handleMessage
        for (const type of ['snapshot', 'session', 'epicRun', 'heartbeat'])
          nextSource.addEventListener?.(type, handleMessage)
        nextSource.onerror = () => {
          source?.close()
          source = undefined
          reconnect()
        }
      }

      const connectWithFetch = async () => {
        controller = new AbortController()
        const response = await fetch(`${root}/api/events`, {
          signal: controller.signal,
        })
        if (!response.ok || !response.body)
          throw new Error(`Forge events failed: ${response.status}`)
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let data = ''
        try {
          while (!stopped) {
            const result = await reader.read()
            if (result.done) break
            buffer += decoder.decode(result.value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) {
              if (line.startsWith('data:')) data += line.slice(5).trimStart()
              if (line === '' && data) {
                retry = 0
                emit(JSON.parse(data))
                data = ''
              }
            }
          }
        } finally {
          reader.cancel().catch(() => undefined)
        }
        if (!stopped) reconnect()
      }

      function connect() {
        if (stopped) return
        if (eventSourceConstructor()) connectWithEventSource()
        else void connectWithFetch().catch(() => reconnect())
      }
      connect()
      return stop
    },
  }
}
