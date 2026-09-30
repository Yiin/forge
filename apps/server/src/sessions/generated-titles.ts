import type { EventBus } from '../events/bus.js'
import { errorMessage } from '../error-message.js'
import type { TitleMessage } from './titles.js'

type Db = { prepare(sql: string): any }

export type TitleGenerator = (input: {
  kind: string
  current: string
  messages: TitleMessage[]
}) => Promise<string | null>

type TitleRow = {
  title: string
  kind: string
  retention: string
  user_titled: number | null
}

function text(content: string) {
  try {
    return (JSON.parse(content) as { text?: string }).text ?? ''
  } catch {
    return ''
  }
}

/**
 * Retitles a session with a small model after each finished turn. One
 * request runs per session; a turn that ends meanwhile asks for one more run.
 */
export class SessionTitler {
  private readonly pending = new Map<string, boolean>()

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly generate: TitleGenerator,
  ) {}

  request(sessionId: string) {
    if (this.pending.has(sessionId)) {
      this.pending.set(sessionId, true)
      return
    }
    this.pending.set(sessionId, false)
    void this.run(sessionId)
      .catch((error) =>
        console.warn(
          `forge: title generation failed for ${sessionId}: ${errorMessage(error)}`,
        ),
      )
      .finally(() => {
        const again = this.pending.get(sessionId)
        this.pending.delete(sessionId)
        if (again) this.request(sessionId)
      })
  }

  private row(sessionId: string) {
    return this.db
      .prepare(
        'SELECT title, kind, retention, user_titled FROM sessions WHERE id = ?',
      )
      .get(sessionId) as TitleRow | undefined
  }

  private async run(sessionId: string) {
    const row = this.row(sessionId)
    if (
      !row ||
      row.user_titled ||
      row.retention === 'discardable' ||
      row.kind === 'subagent'
    )
      return
    const messages = this.messages(sessionId)
    if (!messages.some((message) => message.role === 'user')) return
    const title = await this.generate({
      kind: row.kind,
      current: row.title,
      messages,
    })
    const latest = this.row(sessionId)
    if (!title || !latest || latest.user_titled || latest.title === title)
      return
    this.db
      .prepare('UPDATE sessions SET title = ? WHERE id = ?')
      .run(title, sessionId)
    this.bus.publishEphemeral({
      type: 'sessionTitle',
      seq: null,
      sessionId,
      title,
    })
  }

  /** The opening request and the latest exchange, not the whole history. */
  private messages(sessionId: string): TitleMessage[] {
    const userText = (order: 'ASC' | 'DESC') =>
      this.db
        .prepare(
          `SELECT seq, content FROM messages WHERE session_id = ? AND role = 'user'
           AND type = 'text_delta' ORDER BY seq ${order} LIMIT 1`,
        )
        .get(sessionId) as { seq: number; content: string } | undefined
    const first = userText('ASC')
    const latest = userText('DESC')
    const lastTurn = this.db
      .prepare(
        `SELECT turn_id FROM messages WHERE session_id = ? AND role = 'agent'
         AND type = 'text_delta' ORDER BY seq DESC LIMIT 1`,
      )
      .get(sessionId) as { turn_id: string } | undefined
    const reply = lastTurn
      ? (
          this.db
            .prepare(
              `SELECT content FROM messages WHERE session_id = ? AND turn_id = ?
               AND role = 'agent' AND type = 'text_delta' ORDER BY seq`,
            )
            .all(sessionId, lastTurn.turn_id) as Array<{ content: string }>
        )
          .map((item) => text(item.content))
          .join('')
      : ''
    return [
      ...(first ? [{ role: 'user' as const, text: text(first.content) }] : []),
      ...(latest && latest.seq !== first?.seq
        ? [{ role: 'user' as const, text: text(latest.content) }]
        : []),
      ...(reply ? [{ role: 'assistant' as const, text: reply }] : []),
    ]
  }
}
