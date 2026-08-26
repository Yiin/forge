import { File, FileImage } from 'lucide-react'
import type { ChatRenderItem } from './render-model'

export function AttachmentItem({
  item,
}: {
  item: Extract<ChatRenderItem, { kind: 'attachment' }>
}) {
  return (
    <a
      className="chat-attachment"
      href={`/api/attachments/${encodeURIComponent(item.id)}`}
      target={item.mime?.startsWith('image/') ? '_blank' : undefined}
      rel="noreferrer"
    >
      {item.mime?.startsWith('image/') ? (
        <FileImage size={15} />
      ) : (
        <File size={15} />
      )}{' '}
      {item.filename}
    </a>
  )
}
