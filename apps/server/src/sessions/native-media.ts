import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import type { UploadStore, NativeUpload } from '../uploads/store.js'
import { createNativeAttachmentLoader } from '../uploads/native.js'
import { NativeStorage, sameNativeValue } from './native-storage.js'

type Input = {
  identity: string
  mime: string
  name: string
  size: number
  sha256: string
  bytes: AsyncIterable<Uint8Array>
}
type Receipt = {
  metadata: Omit<Input, 'bytes'>
  upload: NativeUpload
  complete: boolean
}
const active = new WeakMap<UploadStore, Set<string>>()

export async function storeNativeMedia(
  store: NativeStorage,
  uploads: UploadStore,
  activation: string,
  input: Input,
  signal: AbortSignal,
) {
  signal.throwIfAborted()
  store.assertActivation(activation)
  const metadata = {
    identity: input.identity,
    mime: input.mime,
    name: input.name,
    size: input.size,
    sha256: input.sha256,
  }
  const bytes = input.bytes
  if (
    typeof metadata.identity !== 'string' ||
    !metadata.identity ||
    Buffer.byteLength(metadata.identity) > 4096 ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < 0 ||
    metadata.size > 16 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(metadata.sha256)
  )
    throw new Error('Native attachment metadata exceeds limits')
  const key = `media:${createHash('sha256').update(metadata.identity).digest('hex')}`
  const operation = `${store.session.id}:${key}`
  let operations = active.get(uploads)
  if (!operations) active.set(uploads, (operations = new Set()))
  if (operations.has(operation))
    throw new Error('Native attachment operation is still pending')
  if (operations.size >= 32)
    throw new Error('Native attachment operation limit')
  operations.add(operation)
  let receipt: Receipt | undefined
  try {
    receipt = store.get<Receipt | null>(key) ?? undefined
    if (receipt && !sameNativeValue(receipt.metadata, metadata))
      throw new Error('Native attachment identity changed')
    if (receipt?.complete) {
      const row = uploads.attachment(receipt.upload.attachmentId)
      if (
        !row ||
        row.status !== 'complete' ||
        row.session_id !== receipt.upload.sessionId ||
        row.filename !== metadata.name ||
        row.mime !== metadata.mime ||
        row.size_bytes !== metadata.size ||
        row.sha256 !== metadata.sha256
      )
        throw new Error('Native attachment receipt is unavailable')
      const artifact = await createNativeAttachmentLoader(
        uploads.database,
        uploads.dataDir,
      )(store.session.id, receipt.upload.attachmentId, signal)
      await artifact.verifyBytes()
      signal.throwIfAborted()
      store.assertActivation(activation)
      return receipt.upload.attachmentId
    }
    if (receipt) {
      await uploads.discardNative(receipt.upload)
      store.put(key, null)
      receipt = undefined
    }
    signal.throwIfAborted()
    store.assertActivation(activation)
    receipt = store.transaction(signal, () => {
      if (store.pendingMediaCount() >= 32)
        throw new Error('Native attachment cleanup limit')
      const upload = uploads.initNative(store.session.id, {
        filename: metadata.name,
        mime: metadata.mime,
        sizeBytes: metadata.size,
      })
      const value = { metadata, upload, complete: false }
      store.put(key, value)
      return value
    })
    async function* verified() {
      let count = 0
      const hash = createHash('sha256')
      for await (const chunk of bytes) {
        signal.throwIfAborted()
        count += chunk.byteLength
        if (count > metadata.size)
          throw new Error('Native attachment size changed')
        hash.update(chunk)
        yield chunk
      }
      if (count !== metadata.size || hash.digest('hex') !== metadata.sha256)
        throw new Error('Native attachment integrity mismatch')
    }
    const stream = Readable.from(verified())
    try {
      signal.throwIfAborted()
      await uploads.put(
        receipt.upload.attachmentId,
        Readable.toWeb(stream) as ReadableStream<Uint8Array>,
        false,
      )
      signal.throwIfAborted()
      store.assertActivation(activation)
      store.put(key, { ...receipt, complete: true })
      return receipt.upload.attachmentId
    } catch (error) {
      try {
        await uploads.discardNative(receipt.upload)
        store.put(key, null)
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          'Native attachment cleanup failed',
        )
      }
      throw error
    }
  } finally {
    operations.delete(operation)
  }
}
