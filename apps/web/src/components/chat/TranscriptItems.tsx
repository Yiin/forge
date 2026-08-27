import { File, FileImage } from 'lucide-react'
import type { ChatRenderItem } from './render-model'

export function AttachmentItem({
  item,
}: {
  item: Extract<ChatRenderItem, { kind: 'attachment' }>
}) {
  return (
    <a
      className="chat-attachment mx-auto mb-3 flex w-fit max-w-[760px] items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm text-foreground no-underline hover:bg-accent"
      href={`/api/attachments/${encodeURIComponent(item.id)}`}
      target={item.mime?.startsWith('image/') ? '_blank' : undefined}
      rel="noreferrer"
    >
      {item.mime?.startsWith('image/') ? (
        <FileImage className="size-3.5 text-muted-foreground" />
      ) : (
        <File className="size-3.5 text-muted-foreground" />
      )}
      {item.filename}
    </a>
  )
}
