import {
  BarChart3,
  FilePenLine,
  Link2,
  PackageOpen,
  UsersRound,
} from 'lucide-react'
import { useState } from 'react'
import type { ChatRenderItem } from './render-model'
import { WorkEntryRow } from './MessageRow'
import { Button } from '../ui/button'
import { useShellStore } from '../../stores/shell'

type NativeItem = Extract<ChatRenderItem, { kind: 'native' }>

const labels = {
  content_block: 'Content block',
  source_reference: 'Source reference',
  usage: 'Usage',
  usage_snapshot: 'Usage snapshot',
  file_change: 'File change',
  child_updated: 'Child updated',
} as const

export function NativeContentRow({
  item,
  sessionId,
}: {
  item: NativeItem
  sessionId?: string
}) {
  const [open, setOpen] = useState(false)
  const { content } = item
  const detail = nativeDetail(content)
  return (
    <article className="chat-native" data-native-type={content.type}>
      <WorkEntryRow
        icon={iconFor(content.type)}
        heading={labels[content.type]}
        preview={detail}
        expanded={open}
        detailId={`native-detail-${item.id}`}
        onToggle={() => setOpen((value) => !value)}
      >
        <NativeDetail content={content} sessionId={sessionId} />
      </WorkEntryRow>
    </article>
  )
}

function NativeDetail({
  content,
  sessionId,
}: {
  content: NativeItem['content']
  sessionId?: string
}) {
  if (content.type === 'content_block' && 'block' in content) {
    const block = content.block as Record<string, unknown>
    if (sessionId && typeof block.artifactId === 'string')
      return (
        <ArtifactContent
          key={block.artifactId}
          reference={block}
          sessionId={sessionId}
        />
      )
    if (block.kind === 'text_resource' && typeof block.text === 'string')
      return <pre className="whitespace-pre-wrap text-sm">{block.text}</pre>
    if (block.kind === 'resource_link' && typeof block.uri === 'string')
      return (
        <a
          href={block.uri}
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          {String(block.title ?? block.name ?? block.uri)}
        </a>
      )
  }
  if (content.type === 'file_change' && sessionId && 'path' in content) {
    const path = String(content.path)
    return (
      <Button
        variant="outline"
        size="xs"
        onClick={() =>
          useShellStore.getState().openDockTab(sessionId, {
            id: `file-${sessionId}-${path}`,
            kind: 'file',
            title: path.split('/').at(-1) || 'File',
            path,
          })
        }
      >
        Open {path}
      </Button>
    )
  }
  if (content.type === 'child_updated' && sessionId && 'childId' in content) {
    const childId = String(content.childId)
    return (
      <Button
        variant="outline"
        size="xs"
        onClick={() =>
          useShellStore.getState().openDockTab(sessionId, {
            id: `subagent-${sessionId}-${childId}`,
            kind: 'subagent',
            title: 'Child transcript',
            nativeChildId: childId,
          })
        }
      >
        Open child transcript
      </Button>
    )
  }
  if (content.type === 'source_reference' && 'subject' in content) {
    const reference = content.sourceRef
    if (
      sessionId &&
      reference &&
      typeof reference === 'object' &&
      'artifactId' in reference &&
      typeof reference.artifactId === 'string'
    )
      return (
        <ArtifactContent
          key={reference.artifactId}
          reference={reference as Record<string, unknown>}
          sessionId={sessionId}
        />
      )
    return <p className="text-sm">Linked {nativeDetail(content)} source.</p>
  }
  if (content.type === 'usage' || content.type === 'usage_snapshot')
    return (
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        {Object.entries(content)
          .filter(([key, value]) => key !== 'type' && typeof value !== 'object')
          .map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{key}</dt>
              <dd>{String(value)}</dd>
            </div>
          ))}
      </dl>
    )
  if (content.type === 'content_block' && 'block' in content)
    return (
      <p className="text-sm">
        {String((content.block as { kind?: unknown }).kind ?? 'content')} block
      </p>
    )
  if (content.type === 'child_updated' && 'childId' in content)
    return <p className="text-sm">Child {String(content.childId)} updated.</p>
  if (content.type === 'file_change' && 'path' in content)
    return <p className="text-sm">{nativeDetail(content)}</p>
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground">
      {JSON.stringify(content, null, 2)}
    </pre>
  )
}

function iconFor(type: NativeItem['content']['type']) {
  if (type === 'content_block') return PackageOpen
  if (type === 'source_reference') return Link2
  if (type === 'usage' || type === 'usage_snapshot') return BarChart3
  if (type === 'file_change') return FilePenLine
  return UsersRound
}

function nativeDetail(content: NativeItem['content']): string {
  if (content.type === 'file_change' && 'path' in content)
    return `${String(content.kind)} ${String(content.path)}`
  if (content.type === 'usage' && 'totalTokens' in content)
    return `${String(content.totalTokens)} tokens`
  if (content.type === 'usage_snapshot' && 'measurementId' in content)
    return String(content.measurementId)
  if (content.type === 'child_updated' && 'childId' in content)
    return String(content.childId)
  if (content.type === 'source_reference' && 'subject' in content)
    return String((content.subject as { kind?: unknown }).kind ?? 'reference')
  if (content.type === 'content_block' && 'block' in content)
    return String((content.block as { kind?: unknown }).kind ?? 'block')
  return ''
}

function ArtifactContent({
  reference,
  sessionId,
}: {
  reference: Record<string, unknown>
  sessionId: string
}) {
  const [failed, setFailed] = useState(false)
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/acp-artifacts/${encodeURIComponent(String(reference.artifactId))}`
  const image =
    reference.kind === 'image' &&
    ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(
      String(reference.mime),
    )
  const audio =
    reference.kind === 'audio' &&
    ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm'].includes(
      String(reference.mime),
    )
  return (
    <div className="space-y-2 text-sm">
      {image && !failed && (
        <img
          src={url}
          alt="Agent image"
          loading="lazy"
          className="max-h-96 max-w-full rounded-md object-contain"
          onError={() => setFailed(true)}
        />
      )}
      {audio && !failed && (
        <audio
          src={url}
          controls
          preload="none"
          aria-label="Agent audio"
          className="max-w-full"
          onError={() => setFailed(true)}
        />
      )}
      {failed && <p role="status">Media preview is unavailable.</p>}
      <a href={url} download className="underline">
        Download {image ? 'image' : audio ? 'audio' : 'source'}
      </a>
    </div>
  )
}
