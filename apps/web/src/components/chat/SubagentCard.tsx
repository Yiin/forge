import { useEffect, useState } from 'react'
import { Message } from '@forge/protocol/message'
import { connectForgeSocket } from '../../lib/socket'
import { SessionSnapshot } from '@forge/protocol/ws'
import { useMessagesStore } from '../../stores/messages'
import {
  deriveSubagentStatus,
  elapsedSeconds,
  resultPreview,
  toolCount,
  type SubagentSession,
} from './subagent'
import { SubagentTranscript } from './SubagentTranscript'
import { AgentCard } from './AgentCard'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'

const EMPTY_MESSAGES: Message[] = []

export function SubagentCard({
  child,
  skills = [],
}: {
  child: SubagentSession
  skills?: string[]
}) {
  const [expanded, setExpanded] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const messagesBySession = useMessagesStore((state) => state.bySession)
  const messagesVersion = useMessagesStore((state) => state.lastSeq)
  const messages = messagesBySession[child.id] ?? EMPTY_MESSAGES
  const status = deriveSubagentStatus(messages, child.status)
  const tools = toolCount(messages)
  useEffect(() => {
    if (status !== 'running') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [status])

  useEffect(() => {
    if (!expanded || loaded) return
    let active = true
    setLoadError(false)
    void fetch(`/api/sessions/${encodeURIComponent(child.id)}/messages`)
      .then((response) => {
        if (!response.ok) throw new Error('Could not load transcript')
        return response.json()
      })
      .then((rows: unknown) => {
        const snapshot = SessionSnapshot.safeParse({
          ...(rows as object),
          type: 'sessionSnapshot',
          sessionId: child.id,
        })
        if (!active || !snapshot.success) return
        useMessagesStore.getState().loadSnapshot(snapshot.data)
        setLoaded(true)
      })
      .catch(() => {
        if (active) {
          setLoadError(true)
          setLoaded(false)
        }
      })
    return () => {
      active = false
    }
  }, [child.id, expanded, loaded])

  useEffect(() => {
    if (!expanded) return
    const socket = connectForgeSocket({ sessions: [child.id] })
    return () => socket.stop()
  }, [child.id, expanded])

  const failed = status === 'errored' || status === 'interrupted'
  const running = status === 'running'
  const bodyId = `subagent-body-${child.id}`
  const note = 'px-3 py-2 text-xs text-muted-foreground'
  return (
    <AgentCard
      className="subagent-card"
      data-subagent-status={status}
      detail={child.title || 'Subagent'}
      model={child.model}
      meta={
        running
          ? `${elapsedSeconds(messages, now)}s`
          : tools
            ? `${tools} ${tools === 1 ? 'tool' : 'tools'}`
            : undefined
      }
      hint={resultPreview(messages)}
      running={running}
      failed={failed}
      expanded={expanded}
      bodyId={bodyId}
      onToggle={() => setExpanded((value) => !value)}
    >
      {loadError ? (
        <div
          className={cn(note, 'flex items-center justify-between gap-3')}
          role="alert"
        >
          <span>Could not load transcript.</span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => {
              setLoadError(false)
              setLoaded(false)
            }}
          >
            Retry
          </Button>
        </div>
      ) : !loaded && messages.length === 0 ? (
        <div className={note}>Loading transcript…</div>
      ) : messages.length ? (
        <SubagentTranscript
          messages={messages}
          messagesVersion={messagesVersion}
          skills={skills}
        />
      ) : (
        <div className={note}>No transcript items.</div>
      )}
    </AgentCard>
  )
}
