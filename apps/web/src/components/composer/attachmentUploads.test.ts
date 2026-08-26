import { describe, expect, it } from 'vitest'
import {
  attachmentUploadsReducer,
  canSendUploads,
  completedAttachmentIds,
  initialAttachmentUploads,
  type UploadAttachment,
} from './attachmentUploads'

const file = new File(['data'], 'notes.txt', { type: 'text/plain' })
const attachment: UploadAttachment = {
  id: 'local-1',
  file,
  name: file.name,
  size: file.size,
  mime: file.type,
  progress: 0,
  state: 'uploading',
}

describe('attachment uploads', () => {
  it('tracks progress and completion', () => {
    let state = attachmentUploadsReducer(initialAttachmentUploads, {
      type: 'add',
      attachment,
    })
    state = attachmentUploadsReducer(state, {
      type: 'progress',
      id: 'local-1',
      progress: 0.42,
    })
    expect(state.items[0].progress).toBe(0.42)
    state = attachmentUploadsReducer(state, {
      type: 'complete',
      id: 'local-1',
      attachmentId: 'att-1',
    })
    expect(state.items[0]).toMatchObject({
      id: 'att-1',
      state: 'complete',
      progress: 1,
    })
    expect(canSendUploads(state)).toBe(true)
    expect(completedAttachmentIds(state)).toEqual(['att-1'])
  })

  it('gates sending on uploading and failed files, then supports retry', () => {
    let state = attachmentUploadsReducer(initialAttachmentUploads, {
      type: 'add',
      attachment,
    })
    expect(canSendUploads(state)).toBe(false)
    state = attachmentUploadsReducer(state, {
      type: 'fail',
      id: 'local-1',
      error: 'offline',
    })
    expect(canSendUploads(state)).toBe(false)
    state = attachmentUploadsReducer(state, { type: 'retry', id: 'local-1' })
    expect(state.items[0]).toMatchObject({ state: 'uploading', progress: 0 })
  })

  it('removes an attachment', () => {
    const state = attachmentUploadsReducer(
      { items: [attachment] },
      { type: 'remove', id: 'local-1' },
    )
    expect(state.items).toEqual([])
  })
})
