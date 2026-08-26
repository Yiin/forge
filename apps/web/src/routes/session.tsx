import { Timeline } from '../components/chat/Timeline'
import { Composer } from '../components/chat/Composer'
import { SessionHeader } from '../components/chat/SessionHeader'
import { useEffect, useState } from 'react'
import { useParams } from '@tanstack/react-router'
import { api } from '../lib/api'
import { connectForgeSocket, normalizeServerEvent } from '../lib/socket'
import { useMessagesStore } from '../stores/messages'
import { useSessionsStore } from '../stores/sessions'
import { PathSwitcher } from '../components/chat/PathSwitcher'

export function SessionRoute() {
  const { sessionId } = useParams({ from: '/s/$sessionId' })
  const targetSeq = Number(new URLSearchParams(window.location.search).get('m'))
  const [sending, setSending] = useState(false)
  const [harness, setHarness] = useState<string>()
  useEffect(() => {
    const socket = connectForgeSocket({ sessions: [sessionId] })
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((session: { harness?: string } | null) =>
        setHarness(session?.harness),
      )
      .catch(() => undefined)
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
  const send = async (
    text: string,
    attachmentIds: string[],
    selectedHarness: string,
  ) => {
    if (!text.trim()) return
    setSending(true)
    try {
      await api.prompt({
        sessionId,
        text: text.trim(),
        attachmentIds,
        harness: selectedHarness || harness,
      })
      setHarness(selectedHarness || harness)
    } finally {
      setSending(false)
    }
  }
  return (
    <div className="session-view">
      <SessionHeader sessionId={sessionId} />
      <PathSwitcher sessionId={sessionId} />
      <Timeline
        targetSeq={Number.isFinite(targetSeq) ? targetSeq : undefined}
      />
      <Composer
        sessionId={sessionId}
        harness={harness}
        onSend={send}
        sending={sending}
      />
    </div>
  )
}
