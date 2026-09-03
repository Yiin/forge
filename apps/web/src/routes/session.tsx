import { Timeline } from '../components/chat/Timeline'
import { Composer } from '../components/chat/Composer'
import { WorkspaceBar } from '../components/chat/WorkspaceBar'
import { SessionHeader } from '../components/chat/SessionHeader'
import { useEffect, useLayoutEffect, useState } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { api } from '../lib/api'
import { connectForgeSocket, normalizeMessage } from '../lib/socket'
import { useMessagesStore } from '../stores/messages'
import { useSessionsStore, type SessionSummary } from '../stores/sessions'
import { PathSwitcher } from '../components/chat/PathSwitcher'
import { useShellStore } from '../stores/shell'
import { registerShortcuts } from '../lib/shortcuts'
import { ChatLifecycle } from '../components/chat/ChatLifecycle'
import type { ConnectionState } from '../lib/socket'
import type { HarnessSelection } from '../components/chat/harness-picker-logic'
import type { QueuedPrompt } from '@forge/protocol/session'

export function SessionRoute() {
  const { sessionId } = useParams({ from: '/s/$sessionId' })
  const navigate = useNavigate()
  const [composerOverlay, setComposerOverlay] = useState<HTMLDivElement | null>(
    null,
  )
  const [composerHeight, setComposerHeight] = useState(0)
  const targetSeq = Number(new URLSearchParams(window.location.search).get('m'))
  const [sending, setSending] = useState(false)
  const [harness, setHarness] = useState<string>()
  const [accountId, setAccountId] = useState<string>()
  const [model, setModel] = useState<string>()
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
  // The composer floats over the timeline, so the timeline reserves exactly
  // as much room as the composer currently needs.
  useLayoutEffect(() => {
    if (!composerOverlay) return
    const measure = () => {
      const next = Math.ceil(composerOverlay.getBoundingClientRect().height)
      if (next > 0)
        setComposerHeight((current) => (current === next ? current : next))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(composerOverlay)
    return () => observer.disconnect()
  }, [composerOverlay])
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
          accountId?: string | null
          model?: string | null
        }
        if (!active) return
        useShellStore.getState().setLastSession(session.id)
        useSessionsStore.getState().upsertSession(session)
        setHarness(session.harness)
        setAccountId(session.accountId ?? undefined)
        setModel(session.model ?? undefined)
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
            useMessagesStore
              .getState()
              .loadMessages(sessionId, messages.map(normalizeMessage))
          })
          .catch(() => undefined)
        void api
          .listQueued(sessionId)
          .then((value) => {
            const prompts = Array.isArray(value)
              ? value
              : (value as { prompts?: unknown[] }).prompts ?? []
            useMessagesStore.getState().setQueued(sessionId, prompts as QueuedPrompt[])
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
    selection: HarnessSelection,
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
        const clientItemId = `client_${crypto.randomUUID().replaceAll('-', '')}`
        useMessagesStore.getState().addPending({
          sessionId,
          itemId: clientItemId,
          text: value,
          createdAt: new Date().toISOString(),
        })
        try {
          await api.prompt({
            sessionId,
            text: value,
            attachmentIds,
            harness: selection.harness || harness,
            accountId: selection.accountId,
            model: selection.model,
            configOptions: selection.configOptions,
            clientItemId,
          })
        } catch (error) {
          useMessagesStore.getState().removePending(sessionId, clientItemId)
          throw error
        }
        setHarness(selection.harness || harness)
        setAccountId(selection.accountId)
        setModel(selection.model)
      }
    } finally {
      setSending(false)
    }
  }
  const queue = async (
    text: string,
    attachmentIds: string[],
    selection: HarnessSelection,
  ) => {
    await api.prompt({
      sessionId,
      text,
      attachmentIds,
      harness: selection.harness || harness,
      accountId: selection.accountId,
      model: selection.model,
      configOptions: selection.configOptions,
      delivery: 'turn-boundary',
    })
  }
  return (
    <div className="session-view relative flex h-full min-h-0 flex-col">
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
      />
      {!loading && !loadError && (
        <Timeline
          targetSeq={Number.isFinite(targetSeq) ? targetSeq : undefined}
          bottomInset={composerHeight}
        />
      )}
      {!loading && !loadError && (
        <div
          ref={setComposerOverlay}
          className="pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-1.5 bottom-0 z-0 px-3 sm:top-2 sm:px-5"
          >
            <div className="relative mx-auto h-full w-full max-w-3xl overflow-clip rounded-t-[20px]">
              <div className="chat-composer-shared-blur absolute -inset-8" />
            </div>
          </div>
          <div className="chat-composer-lower-chrome pointer-events-auto relative z-10 px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:px-5 sm:pb-[calc(env(safe-area-inset-bottom)+1rem)]">
            <WorkspaceBar
              projectId={
                useSessionsStore
                  .getState()
                  .sessions.find((item) => item.id === sessionId)?.projectId ??
                ''
              }
              sessionId={sessionId}
              disabled={(sessionStatus ?? loadedStatus) === 'running'}
            />
            <Composer
              sessionId={sessionId}
              harness={harness}
              accountId={accountId}
              model={model}
              protocol={protocol}
              running={(sessionStatus ?? loadedStatus) === 'running'}
              onInterrupt={async () => {
                await api.interrupt({ sessionId })
              }}
              onSend={send}
              onQueue={queue}
              sending={sending}
            />
          </div>
        </div>
      )}
    </div>
  )
}
