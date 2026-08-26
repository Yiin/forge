import { SubscribeFrame } from '@forge/protocol/ws'
import { ServerEvent, type Ephemeral } from '@forge/protocol/events'
import type { NodeWebSocket } from '@hono/node-ws'
import { replaySince } from './db/queries.js'
import type { EventBus } from './events/bus.js'

type Database = {
  exec(sql: string): unknown
  prepare(sql: string): { all(...args: unknown[]): unknown }
}
type Socket = {
  send(value: string): void
  close(): void
  raw?: { ping?: () => void }
}
type MessageRow = {
  seq: number
  session_id: string
  turn_id: string
  item_id: string
  role: string
  type: string
  content: string
  created_at: number
}

function eventFromRow(row: MessageRow) {
  return ServerEvent.parse({
    seq: row.seq,
    sessionId: row.session_id,
    msg: {
      seq: row.seq,
      sessionId: row.session_id,
      turnId: row.turn_id,
      itemId: row.item_id,
      role: row.role,
      type: row.type,
      content: JSON.parse(row.content),
      createdAt: new Date(row.created_at).toISOString(),
    },
  })
}

function matchesSession(event: Ephemeral, sessions: string[] | 'all') {
  if (sessions === 'all' || !('sessionId' in event)) return true
  return sessions.includes(event.sessionId)
}

export function websocketRoute(
  upgradeWebSocket: NodeWebSocket['upgradeWebSocket'],
  db: Database,
  bus: EventBus,
) {
  return upgradeWebSocket(() => {
    let socket: Socket | undefined
    let unsubscribePersisted: (() => void) | undefined
    let unsubscribeEphemeral: (() => void) | undefined
    let generation = 0
    let heartbeat: ReturnType<typeof setInterval> | undefined

    const close = () => {
      unsubscribePersisted?.()
      unsubscribeEphemeral?.()
      if (heartbeat) clearInterval(heartbeat)
    }

    const subscribe = async (frame: unknown) => {
      const parsed = SubscribeFrame.safeParse(frame)
      if (!parsed.success || !socket) return socket?.close()
      const current = ++generation
      unsubscribePersisted?.()
      unsubscribeEphemeral?.()
      const buffered: Array<ReturnType<typeof ServerEvent.parse>> = []
      let replaying = true
      let cursor = parsed.data.cursor
      const send = (event: ReturnType<typeof ServerEvent.parse>) => {
        if (current === generation) socket?.send(JSON.stringify(event))
      }
      unsubscribePersisted = bus.subscribePersisted((event) => {
        if (event.sessionId !== event.msg.sessionId) return
        if (
          parsed.data.sessions !== 'all' &&
          !parsed.data.sessions.includes(event.sessionId)
        )
          return
        if (replaying) buffered.push(event)
        else if (event.seq > cursor) {
          cursor = event.seq
          send(event)
        }
      })
      unsubscribeEphemeral = bus.subscribeEphemeral((event) => {
        if (
          matchesSession(event, parsed.data.sessions) &&
          current === generation
        )
          socket?.send(JSON.stringify(event))
      })

      while (current === generation) {
        const rows = replaySince(
          db,
          cursor,
          parsed.data.sessions,
          500,
        ) as MessageRow[]
        if (!rows.length) break
        for (const row of rows) {
          if (current !== generation) return
          const event = eventFromRow(row)
          cursor = Math.max(cursor, event.seq)
          send(event)
        }
        if (rows.length < 500) break
      }
      if (current !== generation) return
      for (const event of buffered) {
        if (event.seq > cursor) {
          cursor = event.seq
          send(event)
        }
      }
      replaying = false
    }

    return {
      onOpen(_event: unknown, ws: unknown) {
        socket = ws as Socket
        heartbeat = setInterval(() => {
          try {
            socket?.raw?.ping?.()
          } catch {
            socket?.close()
          }
        }, 25_000)
        heartbeat.unref?.()
      },
      onMessage(event: MessageEvent) {
        try {
          void subscribe(JSON.parse(String(event.data)))
        } catch {
          socket?.close()
        }
      },
      onClose: close,
      onError: () => socket?.close(),
    }
  })
}
