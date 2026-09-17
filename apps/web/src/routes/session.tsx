import { Timeline } from '../components/chat/Timeline'
import { Composer } from '../components/chat/Composer'
import { WorkspaceBar } from '../components/chat/WorkspaceBar'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { api } from '../lib/api'
import { useWorkspaceTarget } from '../lib/useWorkspaceTarget'
import { connectForgeSocket } from '../lib/socket'
import { useMessagesStore } from '../stores/messages'
import { useSessionsStore, type SessionSummary } from '../stores/sessions'
import { PathSwitcher } from '../components/chat/PathSwitcher'
import { useShellStore } from '../stores/shell'
import { registerShortcuts } from '../lib/shortcuts'
import { ChatLifecycle } from '../components/chat/ChatLifecycle'
import type { ConnectionState } from '../lib/socket'
import type { HarnessSelection } from '../components/chat/harness-picker-logic'
import type { QueuedPrompt } from '@forge/protocol/session'
import { SessionSnapshot } from '@forge/protocol/ws'
import { WorkspaceDock } from '../components/workspace/WorkspaceDock'
import {
  reviewCitation,
  serializeReviewNotes,
  type ReviewNote,
} from '@forge/protocol/review'
import { useReviewNotes, emptyReviewNotes } from '../stores/review-notes'
import { revisionKey, type ReviewRevisionListener } from '../lib/review-notes'

export function SessionRoute() {
  const { sessionId } = useParams({ from: '/s/$sessionId' })
  const activeReviewSession = useRef(sessionId)
  activeReviewSession.current = sessionId
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
  const [skills, setSkills] = useState<string[]>([])
  const reviewComments = useReviewNotes(
    (state) => state.sessions[sessionId] ?? emptyReviewNotes,
  )
  const [reviewError, setReviewError] = useState<string>()
  const [reanchor, setReanchor] = useState<{ sessionId: string; id: string }>()
  const [observations, setObservations] = useState<{
    sessionId: string
    values: Record<string, string>
  }>()
  useEffect(() => {
    useReviewNotes.getState().hydrate()
  }, [])
  const reanchorNote =
    reanchor?.sessionId === sessionId
      ? reviewComments.find((note) => note.id === reanchor.id)
      : undefined
  const onReviewRevision: ReviewRevisionListener = useCallback(
    (workspace, revision, path) => {
      if (activeReviewSession.current !== sessionId) return
      const key = revisionKey(revision, path)
      const value = JSON.stringify([
        workspace.workspaceId,
        workspace.workspaceRevision,
        revision,
      ])
      const keep = new Set(
        (useReviewNotes.getState().sessions[sessionId] ?? []).map(
          ({ anchor }) =>
            revisionKey(
              anchor.revision,
              anchor.newPath ?? anchor.oldPath ?? undefined,
            ),
        ),
      )
      keep.add(key)
      setObservations((prior) =>
        activeReviewSession.current !== sessionId
          ? prior
          : prior?.sessionId === sessionId && prior.values[key] === value
            ? prior
            : {
                sessionId,
                values: {
                  ...Object.fromEntries(
                    Object.entries(
                      prior?.sessionId === sessionId ? prior.values : {},
                    ).filter(([name]) => keep.has(name)),
                  ),
                  [key]: value,
                },
              },
      )
    },
    [sessionId],
  )
  useEffect(() => {
    setReviewError(undefined)
  }, [sessionId])
  const acknowledgeReviewNotes = (notes: ReviewNote[]) => {
    const warning = useReviewNotes.getState().acknowledge(sessionId, notes)
    if (activeReviewSession.current === sessionId) setReviewError(warning)
  }
  const captureReviewNote = (note: ReviewNote) => {
    try {
      if (reanchorNote)
        useReviewNotes
          .getState()
          .reanchor(sessionId, reanchorNote.id, note.anchor)
      else
        useReviewNotes
          .getState()
          .save(sessionId, [
            ...(useReviewNotes.getState().sessions[sessionId] ?? []),
            note,
          ])
      if (activeReviewSession.current === sessionId) {
        setReanchor((current) =>
          current?.sessionId === sessionId && current.id === reanchorNote?.id
            ? undefined
            : current,
        )
        setReviewError(undefined)
      }
    } catch (error) {
      if (activeReviewSession.current === sessionId)
        setReviewError(
          error instanceof Error ? error.message : 'Could not save review note',
        )
      throw error
    }
  }
  const workspaceKey = useSessionsStore((state) => {
    const session = state.sessions.find((item) => item.id === sessionId)
    return JSON.stringify([session?.cwd ?? null, session?.worktreePath ?? null])
  })
  const {
    target: workspaceTarget,
    error: workspaceError,
    retry: retryWorkspace,
  } = useWorkspaceTarget(sessionId, workspaceKey)
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
        void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/skills`)
          .then((response) => (response.ok ? response.json() : null))
          .then((value: { skills?: Array<{ name: string }> } | null) =>
            setSkills((value?.skills ?? []).map((skill) => skill.name)),
          )
          .catch(() => setSkills([]))
        socket = connectForgeSocket({
          sessions: [sessionId],
          onConnectionChange: (state) => active && setConnection(state),
          onReconnect: () => {
            if (!active) return
            void fetch(
              `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
            )
              .then((response) => (response.ok ? response.json() : null))
              .then((snapshot: unknown) => {
                const value = SessionSnapshot.safeParse(snapshot)
                if (value.success)
                  useMessagesStore.getState().loadSnapshot(value.data)
              })
              .catch(() => undefined)
            void api
              .getSession(sessionId)
              .then((value) => {
                if (!active) return
                useSessionsStore
                  .getState()
                  .upsertSession(value as SessionSummary)
              })
              .catch(() => undefined)
            void api
              .listQueued(sessionId)
              .then((value) => {
                const prompts = Array.isArray(value)
                  ? value
                  : ((value as { prompts?: unknown[] }).prompts ?? [])
                if (active)
                  useMessagesStore
                    .getState()
                    .setQueued(sessionId, prompts as QueuedPrompt[])
              })
              .catch(() => undefined)
          },
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
          .then((snapshot: unknown) => {
            const value = SessionSnapshot.safeParse(snapshot)
            if (value.success)
              useMessagesStore.getState().loadSnapshot(value.data)
          })
          .catch(() => undefined)
        void api
          .listQueued(sessionId)
          .then((value) => {
            const prompts = Array.isArray(value)
              ? value
              : ((value as { prompts?: unknown[] }).prompts ?? [])
            useMessagesStore
              .getState()
              .setQueued(sessionId, prompts as QueuedPrompt[])
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
    if (!text.trim() && !attachmentIds.length && !reviewComments.length) return
    setSending(true)
    try {
      const value = text.trim()
      const submittedNotes = reviewComments
      const reviewText = serializeReviewNotes(submittedNotes)
      if (value === '/btw' || value.startsWith('/btw ')) {
        if (submittedNotes.length)
          throw new Error(
            'Review notes stay in this session. Send or remove them before starting a side chat.',
          )
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
          text: value + reviewText,
          createdAt: new Date().toISOString(),
        })
        try {
          await api.prompt({
            sessionId,
            text: value,
            reviewReferences: submittedNotes,
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
        acknowledgeReviewNotes(submittedNotes)
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
    const submittedNotes = reviewComments
    await api.prompt({
      sessionId,
      text,
      reviewReferences: submittedNotes,
      attachmentIds,
      harness: selection.harness || harness,
      accountId: selection.accountId,
      model: selection.model,
      configOptions: selection.configOptions,
      delivery: 'turn-boundary',
    })
    acknowledgeReviewNotes(submittedNotes)
  }
  return (
    <div className="session-view flex h-full min-h-0 min-w-0">
      <div className="relative flex min-w-0 flex-1 flex-col">
        {!loading && !loadError && <PathSwitcher sessionId={sessionId} />}
        {workspaceError && (
          <div
            role="alert"
            className="flex items-center gap-2 px-3 py-2 text-sm"
          >
            <span>{workspaceError}</span>
            <button
              type="button"
              onClick={retryWorkspace}
              className="underline"
            >
              Retry workspace
            </button>
          </div>
        )}
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
        />
        {!loading && !loadError && (
          <Timeline
            targetSeq={Number.isFinite(targetSeq) ? targetSeq : undefined}
            bottomInset={composerHeight}
            skills={skills}
            running={(sessionStatus ?? loadedStatus) === 'running'}
          />
        )}
        {!loading && !loadError && (
          <div
            ref={setComposerOverlay}
            className="pointer-events-none absolute inset-x-0 bottom-0 z-40 max-h-full overflow-y-auto overscroll-contain pt-1.5 sm:pt-2"
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
                    .sessions.find((item) => item.id === sessionId)
                    ?.projectId ?? ''
                }
                sessionId={sessionId}
                disabled={(sessionStatus ?? loadedStatus) === 'running'}
              />
              {reviewComments.length > 0 && (
                <section
                  aria-label="Review notes"
                  className="mx-auto max-h-48 max-w-3xl overflow-y-auto rounded border p-2 text-xs"
                >
                  {reanchorNote && (
                    <p role="status">
                      Select a current Git or file line to re-anchor this note.{' '}
                      <button
                        className="underline"
                        onClick={() => setReanchor(undefined)}
                      >
                        Cancel re-anchor
                      </button>
                    </p>
                  )}
                  {reviewComments.map((note) => {
                    const a = note.anchor
                    const observed =
                      observations?.sessionId === sessionId
                        ? observations.values[
                            revisionKey(
                              a.revision,
                              a.newPath ?? a.oldPath ?? undefined,
                            )
                          ]
                        : undefined
                    const workspaceChanged =
                      'workspaceId' in workspaceTarget &&
                      (workspaceTarget.workspaceId !== a.workspaceId ||
                        workspaceTarget.workspaceRevision !==
                          a.workspaceRevision)
                    const stale =
                      workspaceChanged ||
                      ((a.revision.kind !== 'git' ||
                        a.revision.scope !== 'commit') &&
                        observed !== undefined &&
                        observed !==
                          JSON.stringify([
                            a.workspaceId,
                            a.workspaceRevision,
                            a.revision,
                          ]))
                    return (
                      <div
                        key={note.id}
                        className="border-b py-2 last:border-0"
                      >
                        <p className="break-all">
                          {reviewCitation(note)}{' '}
                          {stale && <strong>Stale anchor</strong>}
                        </p>
                        <p className="whitespace-pre-wrap">{note.body}</p>
                        <button
                          className="min-h-9 underline"
                          onClick={() =>
                            setReanchor({ sessionId, id: note.id })
                          }
                        >
                          Re-anchor note
                        </button>{' '}
                        <button
                          className="min-h-9 underline"
                          onClick={() => {
                            try {
                              useReviewNotes.getState().save(
                                sessionId,
                                reviewComments.filter(
                                  (entry) => entry.id !== note.id,
                                ),
                              )
                            } catch {
                              setReviewError('Could not remove review note')
                            }
                          }}
                        >
                          Remove note
                        </button>
                      </div>
                    )
                  })}
                </section>
              )}
              {reviewError && <p role="alert">{reviewError}</p>}
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
      {!loading && !loadError && (
        <WorkspaceDock
          sessionId={sessionId}
          projectId={
            useSessionsStore
              .getState()
              .sessions.find((item) => item.id === sessionId)?.projectId ?? ''
          }
          target={workspaceTarget}
          onReviewComment={captureReviewNote}
          onReviewRevision={onReviewRevision}
          reanchorNote={reanchorNote}
          overlayBottomInset={composerHeight}
        />
      )}
    </div>
  )
}
