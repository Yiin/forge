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
import { ChatLifecycle } from '../components/chat/ChatLifecycle'
import type { ConnectionState } from '../lib/socket'

export function SessionRoute() {
  const { sessionId } = useParams({ from: '/s/$sessionId' })
  const navigate = useNavigate()
  const targetSeq = Number(new URLSearchParams(window.location.search).get('m'))
  const [sending, setSending] = useState(false)
  const [harness, setHarness] = useState<string>()
  const [protocol, setProtocol] = useState<'acp' | 'pty'>()
  const [loadedStatus, setLoadedStatus] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string>()
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [retryAttempt, setRetryAttempt] = useState(0)
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
          throw new Error(`Session could not be loaded (${response.status})`)
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
        setLoading(false)
        setLoadError(undefined)
        socket = connectForgeSocket({
          sessions: [sessionId],
          onConnectionChange: (state) => active && setConnection(state),
        })
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
      } catch (error) {
        if (active) {
          setLoading(false)
          setLoadError(
            error instanceof Error
              ? error.message
              : 'Session could not be loaded',
          )
        }
      }
    })()
    return () => {
      active = false
      socket?.stop()
    }
  }, [sessionId, navigate, retryAttempt])
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
      {!loading && !loadError && <SessionHeader sessionId={sessionId} />}
      {!loading && !loadError && <PathSwitcher sessionId={sessionId} />}
      <ChatLifecycle
        loading={loading}
        error={loadError}
        onRetry={() => {
          setLoading(true)
          setLoadError(undefined)
          setConnection('connecting')
          setRetryAttempt((attempt) => attempt + 1)
        }}
        connection={connection}
        running={(sessionStatus ?? loadedStatus) === 'running'}
        empty={
          !useMessagesStore(
            (state) => (state.bySession[sessionId] ?? []).length,
          )
        }
      />
      {!loading && !loadError && (
        <Timeline
          targetSeq={Number.isFinite(targetSeq) ? targetSeq : undefined}
        />
      )}
      {!loading && !loadError && (
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
      )}
    </div>
  )
}
