import type { Message } from '@forge/protocol/message'
import { serializeReviewNotes, type ReviewNote } from '@forge/protocol/review'

/**
 * The last prompt the user sent in this session, rebuilt from its stored
 * rows. Each prompt opens a turn with one user `turn_start` row. Its text,
 * without the serialized review notes, is the turn's user text row that is not
 * a steer; an attachment-only prompt has none. Its attachments are the turn's
 * rows written before the first steer.
 */
export function lastPrompt(messages: Message[]):
  | {
      text: string
      reviewReferences: ReviewNote[]
      attachmentIds: string[]
    }
  | undefined {
  const start = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === 'user' && message.content.type === 'turn_start',
    )
  if (!start) return undefined
  const rows = messages
    .slice(messages.indexOf(start) + 1)
    .filter(
      (message) =>
        message.role === 'user' &&
        message.turnId === start.turnId &&
        !('childId' in message.content && message.content.childId),
    )
  const firstSteer = rows.findIndex(
    (message) =>
      message.content.type === 'text_delta' &&
      message.content.steeringRequestId,
  )
  const own = firstSteer === -1 ? rows : rows.slice(0, firstSteer)
  const prompt = own.find((message) => message.content.type === 'text_delta')
  const content =
    prompt?.content.type === 'text_delta' ? prompt.content : undefined
  const reviewReferences = content?.reviewReferences ?? []
  const suffix = serializeReviewNotes(reviewReferences)
  const text = !content
    ? ''
    : suffix && content.text.endsWith(suffix)
      ? content.text.slice(0, -suffix.length)
      : content.text
  const attachmentIds = own.flatMap((message) =>
    message.content.type === 'attachment_ref'
      ? [message.content.attachmentId]
      : [],
  )
  return { text, reviewReferences, attachmentIds }
}
