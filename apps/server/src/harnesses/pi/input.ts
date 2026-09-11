import { createHash } from 'node:crypto'
import { z } from 'zod'
import { promptInputSchema } from '@forge/protocol/harness'
import type { PromptInput } from '../types.js'
import {
  MAX_INLINE_IMAGE_BYTES,
  MAX_INLINE_TOTAL_BYTES,
} from '../../uploads/store.js'
import {
  check,
  fail,
  freeze,
  MiB,
  reservePhysical,
  snapshot,
  waitOwned,
  type PiLimits,
} from './wire.js'

export const imageMime = z.enum([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])
export type PiImageRef = {
  type: 'image'
  attachmentId: string
  mimeType: z.infer<typeof imageMime>
  sizeBytes: number
  sha256: string
}
export type PiLiveOwner = Readonly<{
  kind: 'live'
  forgeSessionId: string
  runtimeGeneration: string
}>
export type PiHistoryOwner = Readonly<{
  kind: 'history_import'
  forgeSessionId: string
  importOperationId: string
}>
export type PiPersistenceOwner = PiLiveOwner | PiHistoryOwner
export type LoadPiImage = (
  forgeSessionId: string,
  attachmentId: string,
  signal: AbortSignal,
) => Promise<{
  mime: PiImageRef['mimeType']
  sizeBytes: number
  sha256: string
  readBytes(signal: AbortSignal): Promise<Uint8Array>
}>
/** Resolution must mean a completed attachment row and stable, committed bytes. */
export type PersistPiImage = (
  owner: PiPersistenceOwner,
  image: { mimeType: PiImageRef['mimeType']; bytes: Uint8Array },
  signal: AbortSignal,
) => Promise<PiImageRef>
export type PiWireImage = {
  type: 'image'
  mimeType: PiImageRef['mimeType']
  data: string
}
export type PiInput = {
  message: string
  attachmentIds: string[]
  attachments: Extract<PromptInput, { type: 'attachment' }>[]
}
export function captureInput(input: PromptInput[] | string): PiInput {
  const copied = snapshot(input, 2 * MiB)
  const parts =
    typeof copied === 'string'
      ? [{ type: 'text' as const, text: copied }]
      : z.array(promptInputSchema).max(64).parse(copied)
  const texts: string[] = []
  const attachments: PiInput['attachments'] = []
  for (const part of parts) {
    if (part.type === 'attachment') {
      imageMime.parse(part.mime)
      if (attachments.length >= 4) fail('PI_IMAGE_COUNT_LIMIT')
      attachments.push(part)
    } else {
      if (attachments.length) fail('PI_INTERLEAVED_INPUT_UNSUPPORTED')
      texts.push(
        part.type === 'text'
          ? part.text
          : `[Review reference${part.title ? `: ${part.title}` : ''}] ${part.url}`,
      )
    }
  }
  const message = texts.join('\n')
  if (Buffer.byteLength(message) > MiB) fail('PI_INPUT_TEXT_LIMIT')
  return freeze({
    message,
    attachments,
    attachmentIds: attachments.map((a) => a.attachmentId),
  })
}
export function imageHash(data: Uint8Array) {
  return createHash('sha256').update(data).digest('hex')
}
export function validateImage(data: Uint8Array, mime: PiImageRef['mimeType']) {
  if (
    !(data instanceof Uint8Array) ||
    !data.byteLength ||
    data.byteLength > MAX_INLINE_IMAGE_BYTES
  )
    fail('PI_IMAGE_SIZE')
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const good =
    mime === 'image/png'
      ? b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mime === 'image/jpeg'
        ? b[0] === 255 && b[1] === 216 && b[2] === 255
        : mime === 'image/gif'
          ? ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('ascii'))
          : mime === 'image/webp' &&
            b.subarray(0, 4).toString('ascii') === 'RIFF' &&
            b.subarray(8, 12).toString('ascii') === 'WEBP'
  if (!good) fail('PI_IMAGE_SIGNATURE')
}
export async function prepareInput(
  input: PiInput,
  sessionId: string,
  load: LoadPiImage,
  signal: AbortSignal,
  config: Readonly<PiLimits>,
): Promise<{ message: string; images: PiWireImage[]; release: () => void }> {
  check(signal)
  if (!input.attachments.length)
    return { message: input.message, images: [], release: () => {} }
  const releaseToken = reservePhysical('attachment')
  const images: PiWireImage[] = []
  const release = () => {
    images.length = 0
    releaseToken()
  }
  let transferred = false
  const actual = (async () => {
    let total = 0
    for (const attachment of input.attachments) {
      check(signal)
      const loaded = await load(sessionId, attachment.attachmentId, signal)
      check(signal)
      const mime = imageMime.parse(loaded.mime)
      const size = loaded.sizeBytes
      const hash = loaded.sha256
      const read = loaded.readBytes
      if (
        mime !== attachment.mime ||
        !Number.isSafeInteger(size) ||
        size <= 0 ||
        size > MAX_INLINE_IMAGE_BYTES ||
        typeof hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(hash) ||
        typeof read !== 'function'
      )
        fail('PI_IMAGE_DESCRIPTOR')
      if (total + size > MAX_INLINE_TOTAL_BYTES) fail('PI_IMAGE_TOTAL_LIMIT')
      check(signal)
      const data = await read.call(loaded, signal)
      check(signal)
      validateImage(data, mime)
      if (data.byteLength !== size || imageHash(data) !== hash)
        fail('PI_IMAGE_CHANGED')
      check(signal)
      total += size
      images.push({
        type: 'image',
        mimeType: mime,
        data: Buffer.from(data).toString('base64'),
      })
      check(signal)
    }
    transferred = true
    return { message: input.message, images, release }
  })().finally(() => {
    if (!transferred) release()
  })
  try {
    return await waitOwned(actual, signal, config.commandMs)
  } catch (error) {
    void actual.then(
      (prepared) => prepared.release(),
      () => {},
    )
    throw error
  }
}
export async function persistWireImages<T>(
  value: T,
  owner: PiPersistenceOwner,
  persist: PersistPiImage,
  signal: AbortSignal,
  config: Readonly<PiLimits>,
  charge: (size: number) => void,
  reserved?: () => void,
): Promise<T> {
  // The native record is already validated. Only image blocks contain base64 data.
  if (!hasWireImage(value)) {
    reserved?.()
    return freeze(value)
  }
  const release = reserved ?? reservePhysical('image')
  const actual = (async () => {
    let total = 0
    const transform = async (v: unknown): Promise<unknown> => {
      check(signal)
      if (!v || typeof v !== 'object') return v
      if (Array.isArray(v)) {
        const result = []
        for (const item of v) result.push(await transform(item))
        return result
      }
      const object = v as Record<string, unknown>
      if (object.type === 'image' && Object.hasOwn(object, 'data')) {
        const mime = imageMime.parse(object.mimeType)
        if (
          typeof object.data !== 'string' ||
          object.data.length > 14 * MiB ||
          object.data.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(object.data)
        )
          fail('PI_IMAGE_ENCODING')
        const data = Buffer.from(object.data, 'base64')
        if (data.toString('base64') !== object.data) fail('PI_IMAGE_ENCODING')
        validateImage(data, mime)
        total += data.length
        if (total > MAX_INLINE_TOTAL_BYTES) fail('PI_IMAGE_TOTAL_LIMIT')
        const hash = imageHash(data)
        charge(data.length)
        const ref = await persist(
          owner,
          { mimeType: mime, bytes: data },
          signal,
        )
        check(signal)
        if (
          ref.type !== 'image' ||
          typeof ref.attachmentId !== 'string' ||
          !ref.attachmentId ||
          ref.attachmentId.length > 256 ||
          ref.mimeType !== mime ||
          ref.sizeBytes !== data.length ||
          ref.sha256 !== hash
        )
          fail('PI_IMAGE_PERSISTENCE_INVALID')
        return freeze({
          type: 'image',
          attachmentId: ref.attachmentId,
          mimeType: mime,
          sizeBytes: data.length,
          sha256: hash,
        })
      }
      const result: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(object))
        result[key] = ['body', 'message', 'content'].includes(key)
          ? await transform(item)
          : item
      return result
    }
    return freeze(await transform(value)) as T
  })().finally(release)
  return waitOwned(actual, signal, config.sinkMs)
}
export function hasWireImage(v: unknown): boolean {
  return (
    !!v &&
    typeof v === 'object' &&
    (Array.isArray(v)
      ? v.some(hasWireImage)
      : ((v as { type?: string }).type === 'image' &&
          Object.hasOwn(v, 'data')) ||
        Object.entries(v).some(
          ([key, item]) =>
            ['body', 'message', 'content'].includes(key) && hasWireImage(item),
        ))
  )
}
