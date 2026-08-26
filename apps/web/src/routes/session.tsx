import { Timeline } from '../components/chat/Timeline'
import { Composer } from '../components/chat/Composer'
import { SessionHeader } from '../components/chat/SessionHeader'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { api } from '../lib/api'
import { connectForgeSocket, normalizeServerEvent } from '../lib/socket'
import { useMessagesStore } from '../stores/messages'
import { useSessionsStore, type SessionSummary } from '../stores/sessions'
import { PathSwitcher } from '../components/chat/PathSwitcher'
import { useShellStore } from '../stores/shell'
import { registerShortcuts } from '../lib/shortcuts'

export function SessionRoute() {
  const { sessionId } = useParams({ from: '/s/$sessionId' })
  const navigate = useNavigate()
  const targetSeq = Number(new URLSearchParams(window.location.search).get('m'))
  const [sending, setSending] = useState(false)
  const [harness, setHarness] = useState<string>()
  const [protocol, setProtocol] = useState<'acp' | 'pty'>()
  const [loadedStatus, setLoadedStatus] = useState<string>()
  const sessionStatus = useSessionsStore(
    (state) =>
      state.sessions.find((session) => session.id === sessionId)?.status,
  )
  useEffect(
    () =>
      registerShortcuts({
        'session.stop': () => void api.interrupt({ sessionId }),
      }),
    [sessionId],
  )
  useEffect(() => {
    let active = true
    let socket: ReturnType<typeof connectForgeSocket> | undefined
    void (async () => {
      try {
        const response = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}`,
        )
        if (!response.ok) {
          if (!active) return
          useShellStore.getState().clearLastSession()
          await navigate({ to: '/', search: { new: '1' } })
          return
        }
        const session = (await response.json()) as SessionSummary & {
          protocol?: 'acp' | 'pty'
        }
        if (!active) return
        useShellStore.getState().setLastSession(session.id)
        useSessionsStore.getState().upsertSession(session)
        setHarness(session.harness)
        setProtocol(session.protocol)
        setLoadedStatus(session.status)
        socket = connectForgeSocket({ sessions: [sessionId] })
        void fetch('/api/status')
          .then((statusResponse) =>
            statusResponse.ok ? statusResponse.json() : null,
          )
          .then(
            (
              status: {
                harnesses?: Array<{ key: string; protocol: 'acp' | 'pty' }>
              } | null,
            ) => {
              const selected = status?.harnesses?.find(
                (entry) => entry.key === session.harness,
              )
              if (selected) setProtocol(selected.protocol)
            },
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
                    (item) => item.parentSessionId !== sessionId,
                  ),
                ...children,
              ])
          })
          .catch(() => undefined)
        void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`)
          .then((messagesResponse) =>
            messagesResponse.ok ? messagesResponse.json() : [],
          )
          .then((messages: unknown) => {
            if (!Array.isArray(messages)) return
            for (const message of messages) {
              const event = normalizeServerEvent(message)
              if (event && typeof event === 'object' && 'msg' in event)
                useMessagesStore.getState().applyEvent(event as never)
            }
          })
          .catch(() => undefined)
      } catch {
        if (active) {
          useShellStore.getState().clearLastSession()
          await navigate({ to: '/', search: { new: '1' } })
        }
      }
    })()
    return () => {
      active = false
      socket?.stop()
    }
  }, [sessionId])
  const send = async (
    text: string,
    attachmentIds: string[],
    selectedHarness: string,
  ) => {
    if (!text.trim()) return
    setSending(true)
    try {
      const value = text.trim()
      if (value === '/btw' || value.startsWith('/btw ')) {
        const result = (await api.btw({
          sessionId,
          text: value.slice(4).trim(),
        })) as { sessionId: string }
        const sideChat = (await api.getSession(result.sessionId)) as {
          id: string
          title: string
          project_id?: string | null
          parent_session_id?: string | null
          forked_at_seq?: number | null
          context_method?: string | null
          context_confidence?: string | null
          [key: string]: unknown
        }
        useSessionsStore.getState().upsertSession({
          ...sideChat,
          projectId: sideChat.project_id,
          parentSessionId: sideChat.parent_session_id,
          forkedAtSeq: sideChat.forked_at_seq,
          contextMethod: sideChat.context_method,
          contextConfidence: sideChat.context_confidence,
        })
        await navigate({
          to: '/s/$sessionId',
          params: { sessionId: result.sessionId },
        })
      } else {
        await api.prompt({
          sessionId,
          text: value,
          attachmentIds,
          harness: selectedHarness || harness,
        })
        setHarness(selectedHarness || harness)
      }
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
        protocol={protocol}
        running={(sessionStatus ?? loadedStatus) === 'running'}
        onInterrupt={async () => {
          await api.interrupt({ sessionId })
        }}
        onSend={send}
        sending={sending}
      />
    </div>
  )
}
