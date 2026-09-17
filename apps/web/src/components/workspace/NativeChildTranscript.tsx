import { useEffect, useState } from 'react'
import { type Message, NativeChildPage } from '@forge/protocol/message'
import { foldEvent } from '../../stores/messages'
import { SubagentTranscript } from '../chat/SubagentTranscript'
import { Button } from '../ui/button'

export function NativeChildTranscript({
  sessionId,
  childId,
}: {
  sessionId: string
  childId: string
}) {
  const [version, setVersion] = useState(0)
  const [messages, setMessages] = useState<Message[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let cursor = 0
    let bytes = 0
    let folded: Parameters<typeof foldEvent>[0] = { bySession: {}, lastSeq: 0 }
    setMessages([])
    setLoading(true)
    setError(null)
    const read = async () => {
      try {
        const response = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/native-children/${encodeURIComponent(childId)}/messages?after=${cursor}&limit=200`,
          { signal: controller.signal },
        )
        if (!response.ok) throw Error('Could not load child transcript')
        const parsed = NativeChildPage.safeParse(await response.json())
        if (!parsed.success) throw Error('Invalid child transcript response')
        const page = parsed.data
        if (controller.signal.aborted) return
        let last = cursor
        for (const message of page.messages) {
          if (
            message.sessionId !== sessionId ||
            message.seq <= last ||
            !('childId' in message.content) ||
            message.content.childId !== childId
          )
            throw Error('Child transcript ownership changed')
          last = message.seq
        }
        if (page.cursor !== last || (page.hasMore && last === cursor))
          throw Error('Invalid child transcript cursor')
        if (page.messages.length)
          bytes += new TextEncoder().encode(
            JSON.stringify(page.messages),
          ).byteLength
        if (bytes > 32 * 1024 * 1024)
          throw Error('Child transcript exceeds the display limit')
        for (const msg of page.messages)
          folded = foldEvent(folded, { sessionId, seq: msg.seq, msg })
        folded.seenSeqs = new Set()
        cursor = page.cursor
        if (page.messages.length) {
          setMessages(folded.bySession[sessionId] ?? [])
          setVersion((value) => value + 1)
        }
        setLoading(false)
        timer = setTimeout(() => void read(), page.hasMore ? 0 : 1000)
      } catch (cause) {
        if (!controller.signal.aborted) {
          setLoading(false)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not load child transcript',
          )
        }
      }
    }
    void read()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [sessionId, childId, retry])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border px-3 py-2 text-sm font-medium">
        Child transcript
      </div>
      {loading && (
        <p role="status" className="p-3 text-sm text-muted-foreground">
          Loading child transcript…
        </p>
      )}
      {error && (
        <div className="p-3 text-sm">
          <p role="alert">{error}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry
          </Button>
        </div>
      )}
      {!loading && !error && !messages.length && (
        <p className="p-3 text-sm text-muted-foreground">
          No child messages yet.
        </p>
      )}
      <SubagentTranscript
        messages={messages}
        messagesVersion={version}
        nativeChildId={childId}
        sessionId={sessionId}
      />
    </div>
  )
}
