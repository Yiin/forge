import { File, FileImage, RotateCcw, X } from 'lucide-react'
import { Button } from '../ui/button'
import { Spinner } from '../ui/spinner'
import { cn } from '@/lib/utils'
import type { UploadAttachment } from './attachmentUploads'

export function AttachmentChips({
  items,
  onRetry,
  onRemove,
}: {
  items: UploadAttachment[]
  onRetry: (id: string) => void
  onRemove: (id: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5 px-2 pt-2" aria-live="polite">
      {items.map((item) => {
        const Icon = item.mime.startsWith('image/') ? FileImage : File
        return (
          <div
            className={cn(
              'relative flex max-w-64 items-center gap-1.5 overflow-hidden rounded-md border bg-muted/50 py-1 pr-1 pl-2 text-xs',
              item.state === 'failed' && 'border-destructive/50',
            )}
            key={item.id}
          >
            {item.state === 'uploading' ? (
              <Spinner className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <Icon
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            )}
            <span className="min-w-0 truncate font-medium" title={item.name}>
              {item.name}
            </span>
            <span className="shrink-0 text-muted-foreground">
              {item.state === 'uploading'
                ? `${Math.round(item.progress * 100)}%`
                : item.state === 'failed'
                  ? 'Failed'
                  : formatBytes(item.size)}
            </span>
            {item.state === 'uploading' && (
              <progress
                className="absolute inset-x-0 bottom-0 h-0.5 w-full appearance-none border-none bg-transparent [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-transparent [&::-webkit-progress-value]:bg-primary"
                max="1"
                value={item.progress}
                aria-label={`Uploading ${item.name}`}
                aria-valuetext={`${Math.round(item.progress * 100)} percent`}
              />
            )}
            {item.state === 'failed' && (
              <>
                <span
                  className="min-w-0 truncate text-destructive"
                  role="status"
                >
                  {item.error || 'Upload failed'}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  onClick={() => onRetry(item.id)}
                  aria-label={`Retry ${item.name}`}
                >
                  <RotateCcw className="size-3.5" />
                </Button>
              </>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={() => onRemove(item.id)}
              aria-label={`Remove ${item.name}`}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        )
      })}
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
