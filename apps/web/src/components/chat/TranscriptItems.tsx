import {
  Check,
  Circle,
  Copy,
  File,
  FileImage,
  TriangleAlert,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ChatRenderItem } from './render-model'
import { GradientSpinner } from './WorkingLine'
import { useCopied } from './useCopied'
import { cn } from '../../lib/utils'

/**
 * A sent file above its prompt, right-aligned like the bubble. Images show
 * as a 112x80 thumb; a file the server has pruned says so.
 */
export function AttachmentItem({
  item,
}: {
  item: Extract<ChatRenderItem, { kind: 'attachment' }>
}) {
  const [removed, setRemoved] = useState(false)
  const href = `/api/attachments/${encodeURIComponent(item.id)}`
  const image = item.mime?.startsWith('image/')
  useEffect(() => {
    const controller = new AbortController()
    void fetch(href, {
      headers: { Range: 'bytes=0-0' },
      signal: controller.signal,
    })
      .then((response) => {
        if (response.status === 410) setRemoved(true)
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [href])
  const Icon = image ? FileImage : File
  return (
    <div className="chat-attachment flex justify-end px-1">
      {removed ? (
        <span className="flex h-8 max-w-full items-center gap-1.5 rounded-lg border border-dashed border-ink/14 bg-ink/[2.5%] px-2.5 text-xs text-muted-foreground">
          <Icon className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{item.filename} · file removed</span>
        </span>
      ) : image ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          title={item.filename}
          className="block h-20 w-28 overflow-hidden rounded-lg border border-ink/11 bg-ink/[3.5%]"
        >
          <img
            src={href}
            alt={item.filename}
            className="size-full rounded-[7px] object-cover"
            loading="lazy"
          />
        </a>
      ) : (
        <a
          href={href}
          rel="noreferrer"
          className="flex h-8 max-w-full items-center gap-1.5 rounded-lg border border-ink/11 bg-ink/[3.5%] px-2.5 text-xs text-foreground no-underline transition-colors duration-150 hover:bg-ink/6"
        >
          <Icon
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span className="truncate">{item.filename}</span>
          {item.sizeBytes !== undefined && (
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {formatBytes(item.sizeBytes)}
            </span>
          )}
        </a>
      )}
    </div>
  )
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
}

/**
 * A turn note. Errors get zeron's red-tinted card with a copy button; other
 * notes, such as "You stopped this turn.", are one quiet line.
 */
export function SystemItem({
  item,
}: {
  item: Extract<ChatRenderItem, { kind: 'system' }>
}) {
  if (!item.alert)
    return (
      <p className="chat-system text-xs leading-[18px] text-muted-foreground">
        {item.text}
      </p>
    )
  return <ErrorCard text={item.text} code={item.code} />
}

function ErrorCard({ text, code }: { text: string; code?: string }) {
  const [copied, copy] = useCopied()
  const message = text.replace(/\s+/g, ' ').trim()
  return (
    <div className="chat-system py-1">
      <div
        className="flex flex-col gap-1.5 rounded-[10px] border border-destructive/16 bg-destructive/5 px-2.5 py-2 text-xs leading-4"
        role="alert"
      >
        <div className="flex items-center gap-2">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-destructive/12">
            <TriangleAlert
              className="size-3 text-destructive-foreground/80"
              aria-hidden
            />
          </span>
          <span className="font-medium text-destructive-foreground/80">
            Error
          </span>
          <button
            type="button"
            aria-label="Copy error"
            title={copied ? 'Copied' : 'Copy error'}
            className="ms-auto flex size-5 cursor-pointer items-center justify-center rounded-md text-destructive-foreground/80 transition-colors duration-150 hover:bg-destructive/12 pointer-coarse:size-11"
            onClick={() => copy(code ? `${message}\n\n${code}` : message)}
          >
            {copied ? (
              <Check className="size-3" aria-hidden />
            ) : (
              <Copy className="size-3" aria-hidden />
            )}
          </button>
        </div>
        <p className="break-words text-foreground/80">{message}</p>
        {code && (
          <details className="chat-system-details">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              Show process details
            </summary>
            <pre className="mt-1.5 max-h-64 overflow-auto rounded-md bg-ink/4 p-2 font-mono text-[11px] leading-4 whitespace-pre-wrap text-foreground/80">
              {code}
            </pre>
          </details>
        )}
      </div>
    </div>
  )
}

/** Plan steps in a quiet card, with a count of the finished ones. */
export function PlanCard({
  item,
}: {
  item: Extract<ChatRenderItem, { kind: 'plan' }>
}) {
  const done = item.steps.filter((step) => step.status === 'completed').length
  return (
    <article
      className="rounded-[10px] border border-ink/8 bg-ink/3 px-3 py-2.5"
      aria-label="Plan progress"
    >
      <div className="flex h-[18px] items-center justify-between gap-3 text-xs">
        <h2 className="font-medium text-muted-foreground">Plan</h2>
        {item.steps.length > 0 && (
          <span className="text-[11px] text-faint-foreground tabular-nums">
            {done}/{item.steps.length} complete
          </span>
        )}
      </div>
      {item.explanation && (
        <p className="mt-1.5 text-[13px] leading-5 whitespace-pre-wrap text-foreground/80">
          {item.explanation}
        </p>
      )}
      {item.steps.length > 0 && (
        <ol className="mt-2 flex flex-col gap-1">
          {item.steps.map((step) => (
            <li
              key={step.id}
              className="flex items-start gap-2 text-[13px] leading-5"
            >
              <span className="flex h-5 w-3.5 shrink-0 items-center justify-center">
                {step.status === 'completed' ? (
                  <Check className="size-3.5 text-success" aria-hidden />
                ) : step.status === 'running' ? (
                  <GradientSpinner />
                ) : step.status === 'failed' ? (
                  <X className="size-3.5 text-destructive" aria-hidden />
                ) : (
                  <Circle
                    className="size-3 text-faint-foreground"
                    aria-hidden
                  />
                )}
              </span>
              <span
                className={cn(
                  'min-w-0',
                  step.status === 'completed'
                    ? 'text-muted-foreground line-through decoration-1'
                    : step.status === 'failed'
                      ? 'text-destructive'
                      : 'text-foreground',
                )}
              >
                {step.title}
              </span>
            </li>
          ))}
        </ol>
      )}
    </article>
  )
}
