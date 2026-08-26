import { Timeline } from '../components/chat/Timeline'
import { useEffect, useState } from 'react'
import { useParams } from '@tanstack/react-router'
import { api } from '../lib/api'
import { connectForgeSocket, normalizeServerEvent } from '../lib/socket'
import { useMessagesStore } from '../stores/messages'
import { useSessionsStore } from '../stores/sessions'

export function SessionRoute() {
  const { sessionId } = useParams({ from: '/s/$sessionId' })
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  useEffect(() => {
    const socket = connectForgeSocket({ sessions: [sessionId] })
    void api
      .listChildSessions(sessionId)
      .then((data) => {
        const children = Array.isArray(data) ? data : (data.sessions ?? [])
        useSessionsStore
          .getState()
          .setSessions([
            ...useSessionsStore
              .getState()
              .sessions.filter(
                (session) => session.parentSessionId !== sessionId,
              ),
            ...children,
          ])
      })
      .catch(() => undefined)
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`)
      .then((response) => (response.ok ? response.json() : []))
      .then((messages: unknown) => {
        if (!Array.isArray(messages)) return
        for (const message of messages) {
          const event = normalizeServerEvent(message)
          if (event && typeof event === 'object' && 'msg' in event)
            useMessagesStore.getState().applyEvent(event as never)
        }
      })
      .catch(() => undefined)
    return () => socket.stop()
  }, [sessionId])
  const send = async () => {
    if (!text.trim()) return
    setSending(true)
    try {
      await api.prompt({ sessionId, text: text.trim() })
      setText('')
    } finally {
      setSending(false)
    }
  }
  return (
    <div className="session-view">
      <Timeline />
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <textarea
          aria-label="Message composer"
          placeholder="Send a message…"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit" disabled={sending || !text.trim()}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </form>
    </div>
  )
}
