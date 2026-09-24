import { useEffect, useState } from 'react'
import type { RefObject } from 'react'
import { CircleX, File as FileIcon, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { UploadAttachment } from './attachmentUploads'
import { ImageLightbox } from '../chat/ImageLightbox'

/** A blob URL for an image file, revoked when the file changes or unmounts. */
function useImagePreview(file: File, mime: string) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!mime.startsWith('image/') || typeof URL.createObjectURL !== 'function')
      return
    const next = URL.createObjectURL(file)
    setUrl(next)
    return () => {
      URL.revokeObjectURL(next)
      setUrl(null)
    }
  }, [file, mime])
  return url
}

const REMOVE_CLASS =
  'absolute -top-1.5 -right-1.5 z-10 grid size-[18px] cursor-pointer place-items-center rounded-full bg-background text-muted-foreground opacity-0 shadow-sm outline-none transition-opacity group-hover/att:opacity-100 hover:text-foreground focus-visible:opacity-100 pointer-coarse:opacity-100 pointer-coarse:after:absolute pointer-coarse:after:-inset-3 pointer-coarse:after:content-[""]'

function Progress({ item }: { item: UploadAttachment }) {
  return (
    <progress
      className="absolute inset-x-0 bottom-0 h-0.5 w-full appearance-none border-none bg-transparent [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-transparent [&::-webkit-progress-value]:bg-primary"
      max="1"
      value={item.progress}
      aria-label={`Uploading ${item.name}`}
      aria-valuetext={`${Math.round(item.progress * 100)} percent`}
    />
  )
}

function AttachmentTile({
  item,
  onRetry,
  onRemove,
  onPreview,
}: {
  item: UploadAttachment
  onRetry: (id: string) => void
  onRemove: (id: string) => void
  onPreview: (preview: { src: string; name: string }) => void
}) {
  const preview = useImagePreview(item.file, item.mime)
  const percent = `${Math.round(item.progress * 100)}%`
  const failed = item.state === 'failed'
  const error = item.error || 'Upload failed'
  const retry = (
    <button
      type="button"
      onClick={() => onRetry(item.id)}
      aria-label={`Retry ${item.name}`}
      className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-full bg-background/90 text-foreground outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-ring"
    >
      <RotateCcw className="size-3.5" />
    </button>
  )
  return (
    <div
      className={cn(
        'group/att relative h-14 shrink-0 rounded-[8px] border bg-ink/3',
        failed ? 'border-destructive/60' : 'border-ink/10',
        preview ? 'w-14' : 'flex max-w-56 min-w-0 items-center gap-2 pr-2 pl-3',
      )}
    >
      {preview ? (
        <div className="relative size-full overflow-hidden rounded-[7px]">
          <button
            type="button"
            aria-label={`Preview ${item.name}`}
            onClick={() => onPreview({ src: preview, name: item.name })}
            className="block size-full cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <img
              src={preview}
              alt={item.name}
              className="size-full object-cover"
              draggable={false}
            />
          </button>
          {item.state === 'uploading' && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black/40 text-[11px] font-medium text-white tabular-nums">
              {percent}
            </div>
          )}
          {failed && (
            <div className="absolute inset-0 grid place-items-center bg-black/40">
              {retry}
              <span className="sr-only" role="status">
                {error}
              </span>
            </div>
          )}
          {item.state === 'uploading' && <Progress item={item} />}
        </div>
      ) : (
        <>
          <FileIcon
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[12px] font-medium text-foreground">
              {item.name}
            </span>
            <span
              className={cn(
                'truncate text-[11px] tabular-nums',
                failed ? 'text-destructive' : 'text-muted-foreground',
              )}
              role={failed ? 'status' : undefined}
            >
              {item.state === 'uploading'
                ? percent
                : failed
                  ? error
                  : formatBytes(item.size)}
            </span>
          </span>
          {failed && retry}
          {item.state === 'uploading' && <Progress item={item} />}
        </>
      )}
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          onRemove(item.id)
        }}
        aria-label={`Remove ${item.name}`}
        className={REMOVE_CLASS}
      >
        <CircleX className="size-3.5" />
      </button>
    </div>
  )
}

/** Staged uploads inside the composer pill: 56px tiles that wrap. */
export function AttachmentChips({
  items,
  onRetry,
  onRemove,
  returnFocus,
}: {
  items: UploadAttachment[]
  onRetry: (id: string) => void
  onRemove: (id: string) => void
  /** Where focus goes when the lightbox closes: the composer input. */
  returnFocus?: RefObject<HTMLElement | null>
}) {
  const [preview, setPreview] = useState<{ src: string; name: string }>()
  return (
    <div className="flex flex-wrap gap-2" aria-live="polite">
      {items.map((item) => (
        <AttachmentTile
          key={item.id}
          item={item}
          onRetry={onRetry}
          onRemove={onRemove}
          onPreview={setPreview}
        />
      ))}
      <ImageLightbox
        src={preview?.src ?? null}
        name={preview?.name ?? ''}
        onClose={() => setPreview(undefined)}
        finalFocus={returnFocus}
      />
    </div>
  )
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit++
  } while (value >= 1024 && unit < units.length - 1)
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}
