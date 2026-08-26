import { File, FileImage, LoaderCircle, RotateCcw, X } from 'lucide-react'
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
    <div className="composer-attachments" aria-live="polite">
      {items.map((item) => {
        const Icon = item.mime.startsWith('image/') ? FileImage : File
        return (
          <div
            className={`attachment-chip attachment-${item.state}`}
            key={item.id}
          >
            {item.state === 'uploading' ? (
              <LoaderCircle className="attachment-spinner" size={16} />
            ) : (
              <Icon size={16} />
            )}
            <span className="attachment-chip-name" title={item.name}>
              {item.name}
            </span>
            <span className="attachment-chip-meta">
              {item.state === 'uploading'
                ? `${Math.round(item.progress * 100)}%`
                : item.state === 'failed'
                  ? 'Failed'
                  : formatBytes(item.size)}
            </span>
            {item.state === 'uploading' && (
              <progress
                max="1"
                value={item.progress}
                aria-label={`Uploading ${item.name}`}
                aria-valuetext={`${Math.round(item.progress * 100)} percent`}
              />
            )}
            {item.state === 'failed' && (
              <>
                <span className="attachment-chip-error" role="status">
                  {item.error || 'Upload failed'}
                </span>
                <button
                  type="button"
                  onClick={() => onRetry(item.id)}
                  aria-label={`Retry ${item.name}`}
                >
                  <RotateCcw size={16} />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => onRemove(item.id)}
              aria-label={`Remove ${item.name}`}
            >
              <X size={16} />
            </button>
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
