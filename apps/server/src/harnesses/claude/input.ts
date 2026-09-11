import { isAbsolute } from 'node:path'
import { promptInputSchema } from '@forge/protocol/harness'
import type { PromptInput } from '../types.js'
import { MiB } from './wire.js'

export type Attachment = {
  mime: string
  name: string
  path: string
  sizeBytes: number
  readBytes: () => Promise<Uint8Array>
}
/** The caller authorizes session ownership, completed upload state, containment, and file stability. */
export type LoadAttachment = (
  sessionId: string,
  attachmentId: string,
  signal: AbortSignal,
) => Promise<Attachment>
export type InputBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      source: { type: 'base64'; media_type: string; data: string }
    }
export function validateInput(input: PromptInput[] | string): PromptInput[] {
  const parts =
    typeof input === 'string' ? [{ type: 'text' as const, text: input }] : input
  if (!Array.isArray(parts) || parts.length > 64 || parts.length === 0)
    throw new Error('Claude accepts 1 to 64 input parts')
  const parsed = parts.map((part) => {
    const value = promptInputSchema.safeParse(part)
    if (!value.success) throw new Error('Invalid Claude prompt input')
    return value.data
  })
  let textBytes = 0
  let images = 0
  for (const part of parsed) {
    if (part.type === 'text') textBytes += Buffer.byteLength(part.text)
    if (part.type === 'review_reference')
      textBytes += Buffer.byteLength(
        `${part.title ?? 'Review reference'}\n${part.url}`,
      )
    if (part.type === 'attachment' && part.mime.startsWith('image/')) {
      if (!imageMimes.has(part.mime))
        throw new Error('Claude does not support this image MIME type')
      images++
    }
  }
  if (textBytes > MiB) throw new Error('Claude prompt text exceeds 1 MiB')
  if (images > 4) throw new Error('Claude accepts at most four images')
  return parsed
}
const imageMimes = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])
export async function prepareInput(
  parts: PromptInput[],
  sessionId: string,
  load: LoadAttachment | undefined,
  work: AttachmentWork,
  signal: AbortSignal,
  check: () => void,
): Promise<InputBlock[]> {
  const blocks: InputBlock[] = []
  let rawBytes = 0
  let textBytes = 0
  const addText = (text: string) => {
    textBytes += Buffer.byteLength(text)
    if (textBytes > MiB) throw new Error('Claude prompt text exceeds 1 MiB')
    blocks.push({ type: 'text', text })
  }
  try {
    for (const part of parts) {
      check()
      if (part.type === 'text') addText(part.text)
      else if (part.type === 'review_reference')
        addText(`${part.title ?? 'Review reference'}\n${part.url}`)
      else {
        if (!load) throw new Error('Claude attachment loader is unavailable')
        const attachment = await work.run(
          () => load(sessionId, part.attachmentId, signal),
          signal,
        )
        check()
        if (
          attachment.mime !== part.mime ||
          !isAbsolute(attachment.path) ||
          !attachment.name ||
          !Number.isSafeInteger(attachment.sizeBytes) ||
          attachment.sizeBytes < 0
        )
          throw new Error('Invalid authorized attachment descriptor')
        if (imageMimes.has(attachment.mime)) {
          if (attachment.sizeBytes < 1 || attachment.sizeBytes > 5 * MiB)
            throw new Error('Claude image exceeds 5 MiB')
          rawBytes += attachment.sizeBytes
          if (rawBytes > 20 * MiB)
            throw new Error('Claude image total exceeds 20 MiB')
          const bytes = await work.run(() => attachment.readBytes(), signal)
          check()
          if (
            !(bytes instanceof Uint8Array) ||
            bytes.length !== attachment.sizeBytes
          )
            throw new Error('Claude attachment size changed')
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: attachment.mime,
              data: Buffer.from(bytes).toString('base64'),
            },
          })
        } else addText(`File: ${attachment.name}\n${attachment.path}`)
      }
    }
    check()
    return blocks
  } catch (error) {
    blocks.length = 0
    throw error
  }
}

/** Cancellation rejects the caller; actual loader or reader settlement releases admission. */
export class AttachmentWork {
  private active = false
  run<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (this.active)
      return Promise.reject(new Error('Claude attachment work is still active'))
    if (signal.aborted)
      return Promise.reject(
        new Error('Claude attachment preparation was cancelled'),
      )
    this.active = true
    let promise: Promise<T>
    try {
      promise = start()
    } catch (error) {
      this.active = false
      return Promise.reject(error)
    }
    return abortable(
      promise.finally(() => {
        this.active = false
      }),
      signal,
    )
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(new Error('Claude attachment preparation was cancelled'))
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        if (signal.aborted) abort()
        else resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
    if (signal.aborted) abort()
  })
}
