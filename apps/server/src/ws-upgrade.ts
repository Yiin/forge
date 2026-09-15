import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import {
  WebSocketServer,
  type WebSocket,
  type RawData,
  type ServerOptions,
} from 'ws'
import type { Hono } from 'hono'
import { defineWebSocketHelper, WSContext, type WSEvents } from 'hono/ws'
import type { NodeWebSocket } from '@hono/node-ws'
import { RequestGuard } from './request-guard.js'

type Registration = {
  events: WSEvents<WebSocket>
  url: string
  onError?: (error: unknown) => void
}
type Opening = {
  request: IncomingMessage
  socket: Duplex
  controller: AbortController
  registration: Registration | null
  registered: number
  settled: boolean
  upgraded: boolean
  closed: boolean
  transportClosed?: () => void
  timer: ReturnType<typeof setTimeout>
}
// ws 8.21.3 implements these bounds; the published @types/ws version omits them.
const terminalOptions: ServerOptions & {
  maxFragments: number
  maxBufferedChunks: number
  closeTimeout: number
} = {
  noServer: true,
  maxPayload: 1024,
  maxFragments: 16,
  maxBufferedChunks: 16,
  perMessageDeflate: false,
  closeTimeout: 1000,
}
export class WebSocketUpgrades {
  private readonly contexts = new WeakMap<IncomingMessage, Opening>()
  private readonly openings = new Set<Opening>()
  private readonly session = new WebSocketServer({ noServer: true })
  private readonly terminal = new WebSocketServer(terminalOptions)
  private stopping = false
  readonly upgradeWebSocket: NodeWebSocket['upgradeWebSocket']
  constructor(
    private readonly app: Hono,
    private readonly maxOpening = 32,
    private readonly deadlineMs = 6000,
    private readonly requestGuard = new RequestGuard(),
  ) {
    this.upgradeWebSocket = defineWebSocketHelper<
      WebSocket,
      { onError: (error: unknown) => void }
    >((c, events, options) => {
      const incoming = (c.env as { incoming?: IncomingMessage }).incoming
      const owner = incoming && this.contexts.get(incoming)
      if (!owner || owner.controller.signal.aborted || owner.settled)
        throw new Error('WebSocket upgrade is unavailable')
      if (++owner.registered !== 1)
        throw new Error('WebSocket route registered twice')
      owner.registration = { events, url: c.req.url, onError: options?.onError }
      return new Response(null, { status: 200 })
    })
  }
  opening(request: IncomingMessage, transportClosed: () => void) {
    const owner = this.contexts.get(request)
    if (
      !owner ||
      owner.controller.signal.aborted ||
      owner.closed ||
      owner.transportClosed
    )
      throw new Error('WebSocket opening is unavailable')
    owner.transportClosed = transportClosed
    return owner.controller.signal
  }
  install(server: Server) {
    if (server.listenerCount('upgrade'))
      throw new Error('Only one Forge WebSocket upgrade listener is allowed')
    server.on('upgrade', (request, socket, head) => {
      if (this.stopping || this.openings.size >= this.maxOpening)
        return this.reject(socket, 503)
      const path = request.url?.split('?')[0]
      const terminal =
        /^\/api\/sessions\/[^/]+\/terminals\/[^/]+\/events$/.test(path ?? '')
      if (path !== '/ws' && !terminal) return this.reject(socket, 404)
      const guard = this.requestGuard.check(
        new Request(
          `http://${request.headers.host ?? 'forge.invalid'}${request.url ?? '/'}`,
          {
            method: 'GET',
            headers: request.headers as HeadersInit,
          },
        ),
        { incoming: request },
      )
      if (guard) return this.reject(socket, 403)
      const controller = new AbortController()
      const owner: Opening = {
        request,
        socket,
        controller,
        registration: null,
        registered: 0,
        settled: false,
        upgraded: false,
        closed: false,
        timer: setTimeout(() => {
          controller.abort()
          socket.destroy()
        }, this.deadlineMs),
      }
      this.openings.add(owner)
      this.contexts.set(request, owner)
      const collect = () => {
        if (owner.settled && (owner.closed || owner.upgraded)) {
          clearTimeout(owner.timer)
          this.openings.delete(owner)
          this.contexts.delete(request)
        }
      }
      socket.once('close', () => {
        owner.closed = true
        controller.abort()
        owner.transportClosed?.()
        collect()
      })
      socket.once('error', () => {
        controller.abort()
        socket.destroy()
      })
      void (async () => {
        try {
          const headers = new Headers()
          for (let i = 0; i < request.rawHeaders.length; i += 2)
            headers.append(request.rawHeaders[i]!, request.rawHeaders[i + 1]!)
          const response = await this.app.request(
            new Request(`http://forge.invalid${request.url}`, {
              method: 'GET',
              headers,
              signal: controller.signal,
            }),
            undefined,
            { incoming: request, outgoing: undefined },
          )
          if (owner.closed || controller.signal.aborted || this.stopping) {
            socket.destroy()
            return
          }
          if (
            owner.registered !== 1 ||
            !owner.registration ||
            response.status >= 400
          ) {
            this.reject(socket, response.status >= 400 ? response.status : 400)
            return
          }
          const registration = owner.registration
          const wss = terminal ? this.terminal : this.session
          wss.handleUpgrade(request, socket, head, (ws) => {
            if (controller.signal.aborted || this.stopping) {
              ws.terminate()
              return
            }
            owner.upgraded = true
            this.attach(ws, registration)
          })
          // A rejected handshake does not invoke the callback. Its original socket
          // retains the opening owner until close or the opening deadline.
        } catch {
          socket.destroy()
        } finally {
          owner.settled = true
          collect()
        }
      })()
    })
  }
  private reject(socket: Duplex, status: number) {
    try {
      socket.end(
        `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      )
    } finally {
      socket.destroy()
    }
  }
  private attach(socket: WebSocket, registration: Registration) {
    const context = new WSContext({
      raw: socket,
      get readyState() {
        return socket.readyState
      },
      url: registration.url,
      protocol: socket.protocol,
      send: (data, options) =>
        socket.send(data, { compress: options?.compress }),
      close: (code, reason) => socket.close(code, reason),
    })
    Object.defineProperty(context, 'bufferedAmount', {
      get: () => socket.bufferedAmount,
    })
    const invoke = (action: () => void) => {
      try {
        action()
      } catch (error) {
        registration.onError?.(error)
        socket.close()
      }
    }
    socket.on('close', (code, reason) =>
      invoke(() =>
        registration.events.onClose?.(
          new CloseEvent('close', { code, reason: reason.toString() }),
          context,
        ),
      ),
    )
    socket.on('error', () =>
      invoke(() => registration.events.onError?.(new Event('error'), context)),
    )
    socket.on('message', (data: RawData, binary: boolean) =>
      invoke(() => {
        const bytes = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : data
        registration.events.onMessage?.(
          new MessageEvent('message', {
            data: binary
              ? bytes.buffer.slice(
                  bytes.byteOffset,
                  bytes.byteOffset + bytes.byteLength,
                )
              : bytes.toString('utf8'),
          }),
          context,
        )
      }),
    )
    invoke(() => registration.events.onOpen?.(new Event('open'), context))
  }
  stopAccepting() {
    this.stopping = true
    for (const opening of this.openings) {
      opening.controller.abort()
      opening.socket.destroy()
    }
  }
  async close(): Promise<boolean> {
    this.stopAccepting()
    const sockets = [...this.session.clients, ...this.terminal.clients]
    const closed = sockets.map(
      (socket) =>
        new Promise<void>((resolve) => {
          if (socket.readyState === socket.CLOSED) {
            resolve()
            return
          }
          const timer = setTimeout(() => socket.terminate(), 1000)
          socket.once('close', () => {
            clearTimeout(timer)
            resolve()
          })
          socket.close()
        }),
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.all(closed),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 1100)
      }),
    ])
    if (timer) clearTimeout(timer)
    return (
      this.openings.size === 0 &&
      this.session.clients.size === 0 &&
      this.terminal.clients.size === 0
    )
  }
  resourceState() {
    return {
      openings: this.openings.size,
      sessionSockets: this.session.clients.size,
      terminalSockets: this.terminal.clients.size,
    }
  }
}
