export type UploadState = 'uploading' | 'complete' | 'failed'

export type UploadAttachment = {
  id: string
  file: File
  name: string
  size: number
  mime: string
  progress: number
  state: UploadState
  error?: string
}

export type AttachmentUploads = { items: UploadAttachment[] }

export type AttachmentAction =
  | { type: 'add'; attachment: UploadAttachment }
  | { type: 'progress'; id: string; progress: number }
  | { type: 'complete'; id: string; attachmentId: string }
  | { type: 'fail'; id: string; error?: string }
  | { type: 'retry'; id: string }
  | { type: 'remove'; id: string }

export const initialAttachmentUploads: AttachmentUploads = { items: [] }

export function attachmentUploadsReducer(
  state: AttachmentUploads,
  action: AttachmentAction,
): AttachmentUploads {
  const items = state.items
  switch (action.type) {
    case 'add': return { items: [...items, action.attachment] }
    case 'progress': return map(items, action.id, (item) => ({ ...item, progress: Math.max(0, Math.min(1, action.progress)) }))
    case 'complete': return map(items, action.id, (item) => ({ ...item, id: action.attachmentId, progress: 1, state: 'complete', error: undefined }))
    case 'fail': return map(items, action.id, (item) => ({ ...item, state: 'failed', error: action.error }))
    case 'retry': return map(items, action.id, (item) => ({ ...item, state: 'uploading', progress: 0, error: undefined }))
    case 'remove': return { items: items.filter((item) => item.id !== action.id) }
  }
}

function map(items: UploadAttachment[], id: string, update: (item: UploadAttachment) => UploadAttachment) {
  return { items: items.map((item) => item.id === id ? update(item) : item) }
}

export function canSendUploads(state: AttachmentUploads) {
  return !state.items.some((item) => item.state !== 'complete')
}

export function completedAttachmentIds(state: AttachmentUploads) {
  return state.items.filter((item) => item.state === 'complete').map((item) => item.id)
}
