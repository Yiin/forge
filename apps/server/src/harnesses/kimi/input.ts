import { randomUUID } from 'node:crypto'
import {
  dispatchOptionsSchema,
  promptInputSchema,
} from '@forge/protocol/harness'
import type { DispatchOptions, PromptInput } from '../types.js'
import {
  KimiError,
  KimiBudget,
  boundedString,
  deadline,
  jsonBytes,
  reserveAll,
  kimiLimits,
  type KimiLimits,
} from './limits.js'
import type { KimiCatalog, KimiLoadAttachment } from './types.js'
import type { KimiHostOwner, KimiLease } from './host.js'
import { object } from './transport.js'

export type KimiSettings = {
  model?: string
  thinking?: string
  permission_mode: 'manual' | 'auto' | 'yolo'
}
export function resolveSettings(
  options: DispatchOptions | undefined,
  defaults: KimiSettings,
  catalog: KimiCatalog,
  limits: Readonly<KimiLimits> = kimiLimits(),
): KimiSettings {
  const hasPermissionMode = options?.permissionMode !== undefined
  if (options !== undefined) {
    jsonBytes(options, limits, limits.httpControlBytes)
    options = dispatchOptionsSchema.strict().parse(options)
  }
  if (
    options?.approvalPolicy != null ||
    options?.sandboxPolicy != null ||
    options?.serviceTier != null
  )
    throw new KimiError('kimi_unsupported_options')
  const model =
    options?.model === null
      ? catalog.defaultModel
      : (options?.model ?? defaults.model)
  const thinking =
    options?.reasoning === null
      ? catalog.defaultEffort
      : (options?.reasoning ?? defaults.thinking)
  if (
    (options?.model === null && !model) ||
    (options?.reasoning === null && !thinking)
  )
    throw new KimiError('kimi_default_unavailable')
  const effectiveModel = model ?? catalog.defaultModel
  const item = effectiveModel
    ? catalog.models.find((entry) => entry.id === effectiveModel)
    : undefined
  if (model !== undefined && (!model || !item))
    throw new KimiError('kimi_model_unsupported')
  if (
    thinking !== undefined &&
    (!thinking || !item?.efforts?.includes(thinking))
  )
    throw new KimiError('kimi_effort_unsupported')
  return {
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    permission_mode: hasPermissionMode
      ? options!.permissionMode
      : defaults.permission_mode,
  }
}
export function captureInput(
  input: PromptInput[] | string,
  budget: KimiBudget,
): readonly PromptInput[] {
  const parts =
    typeof input === 'string' ? [{ type: 'text' as const, text: input }] : input
  if (!Array.isArray(parts) || parts.length > budget.limits.promptInputParts)
    throw new KimiError('kimi_prompt_parts_limit')
  jsonBytes(parts, budget.limits, budget.limits.retainedBytes)
  let text = 0,
    attachments = 0
  for (const raw of parts) {
    const part = promptInputSchema.parse(raw)
    if (part.type === 'text') text += Buffer.byteLength(part.text)
    else if (part.type === 'review_reference')
      text += Buffer.byteLength(part.url) + Buffer.byteLength(part.title ?? '')
    else if (part.type === 'attachment') {
      boundedString(part.attachmentId, budget.limits.forgeIdBytes)
      boundedString(part.mime, budget.limits.nativeIdBytes)
      if (!/^[\w.+-]+\/[\w.+-]+$/.test(part.mime))
        throw new KimiError('kimi_attachment_mime')
      attachments++
    } else throw new KimiError('kimi_input_unsupported')
  }
  if (
    text > budget.limits.promptTextBytes ||
    attachments > budget.limits.attachmentsPerPrompt
  )
    throw new KimiError('kimi_prompt_limit')
  return parts
}
export function promptTextBytes(parts: readonly PromptInput[]) {
  return parts.reduce(
    (bytes, part) =>
      bytes +
      (part.type === 'text'
        ? Buffer.byteLength(part.text)
        : part.type === 'review_reference'
          ? Buffer.byteLength(part.url) + Buffer.byteLength(part.title ?? '')
          : 0),
    0,
  )
}
export function validatePromptEnvelope(
  parts: readonly PromptInput[],
  settings: KimiSettings,
  budget: KimiBudget,
) {
  const largestId = '\0'.repeat(budget.limits.nativeIdBytes)
  const content = parts.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : part.type === 'review_reference'
        ? {
            type: 'text',
            text: part.title ? `${part.title}\n${part.url}` : part.url,
          }
        : part.mime.startsWith('image/') || part.mime.startsWith('video/')
          ? {
              type: part.mime.startsWith('image/') ? 'image' : 'video',
              source: { kind: 'file', file_id: largestId },
            }
          : {
              type: 'file',
              file_id: largestId,
              name: largestId,
              media_type: part.mime,
              size: budget.limits.attachmentBytes,
            },
  )
  validateExactPromptEnvelope(content, settings, budget)
}
export function validateExactPromptEnvelope(
  content: readonly unknown[],
  settings: KimiSettings,
  budget: KimiBudget,
) {
  try {
    jsonBytes(
      { content, ...settings },
      budget.limits,
      budget.limits.httpControlBytes,
    )
  } catch (error) {
    if (error instanceof KimiError && error.code === 'kimi_json_bytes')
      throw new KimiError(
        'kimi_prompt_envelope_limit',
        'The encoded Kimi prompt exceeds the request limit',
      )
    throw error
  }
}
export async function prepareInput(
  parts: readonly PromptInput[],
  sessionId: string,
  lease: KimiLease,
  host: KimiHostOwner,
  budget: KimiBudget,
  loader: KimiLoadAttachment | undefined,
  signal: AbortSignal,
  orphan: (ids: readonly string[]) => Promise<void>,
) {
  const content: unknown[] = [],
    uploaded: string[] = [],
    releases: (() => void)[] = []
  let total = 0
  let abandoned = false
  const discard = async (ids: readonly string[]) => {
    const unresolved: string[] = []
    for (const id of ids) {
      try {
        await lease.server.http(
          lease.lane,
          `/api/v1/files/${encodeURIComponent(id)}`,
          { method: 'DELETE' },
        )
      } catch {
        unresolved.push(id)
      }
    }
    if (unresolved.length) await orphan(unresolved)
  }
  const abandon = async () => {
    if (abandoned) return
    abandoned = true
    await discard(uploaded)
  }
  try {
    for (const part of parts) {
      signal.throwIfAborted()
      if (part.type === 'text') {
        content.push({ type: 'text', text: part.text })
        continue
      }
      if (part.type === 'review_reference') {
        content.push({
          type: 'text',
          text: part.title ? `${part.title}\n${part.url}` : part.url,
        })
        continue
      }
      if (!loader) throw new KimiError('kimi_attachment_loader_missing')
      const release = reserveAll([
        [host.budget, 'hostAttachmentLoads'],
        [budget, 'runtimeAttachmentLoads'],
      ])
      const physical = host.track(
        Promise.resolve()
          .then(async () => {
            const descriptor = await loader(
              sessionId,
              part.attachmentId,
              signal,
            )
            signal.throwIfAborted()
            boundedString(descriptor.name, budget.limits.nativeIdBytes)
            if (
              descriptor.mime !== part.mime ||
              !Number.isSafeInteger(descriptor.sizeBytes) ||
              descriptor.sizeBytes < 0 ||
              descriptor.sizeBytes > budget.limits.attachmentBytes ||
              /[\r\n"\\]/.test(descriptor.name) ||
              !/^[\w.+-]+\/[\w.+-]+$/.test(descriptor.mime)
            )
              throw new KimiError('kimi_attachment_descriptor')
            if (
              total + descriptor.sizeBytes >
              budget.limits.promptAttachmentBytes
            )
              throw new KimiError('kimi_prompt_attachment_limit')
            const releaseBytes = host.budget.reserve(
              'hostAttachmentBytes',
              descriptor.sizeBytes,
            )
            let delivered = false
            try {
              const bytes = await descriptor.readBytes()
              signal.throwIfAborted()
              if (
                !(bytes instanceof Uint8Array) ||
                bytes.length !== descriptor.sizeBytes ||
                bytes.length > budget.limits.attachmentBytes
              )
                throw new KimiError('kimi_attachment_bytes')
              delivered = true
              return { descriptor, bytes, releaseBytes }
            } finally {
              if (!delivered) releaseBytes()
            }
          })
          .finally(release),
      )
      let delivered = false
      void physical
        .then((value) => {
          if (signal.aborted && !delivered) value.releaseBytes()
        })
        .catch(() => {})
      let loaded: Awaited<typeof physical>
      try {
        loaded = await deadline(
          physical,
          budget.limits.attachmentMs,
          signal,
          budget,
          host.budget,
        )
      } catch (error) {
        void physical.then((value) => value.releaseBytes()).catch(() => {})
        throw error
      }
      delivered = true
      const { descriptor, bytes, releaseBytes } = loaded
      releases.push(releaseBytes)
      total += bytes.length
      if (total > budget.limits.promptAttachmentBytes)
        throw new KimiError('kimi_prompt_attachment_limit')
      const boundary = `forge-${randomUUID()}`
      const prefixText = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${descriptor.name}"\r\nContent-Type: ${descriptor.mime}\r\n\r\n`,
        suffixText = `\r\n--${boundary}--\r\n`
      const multipartBytes =
        Buffer.byteLength(prefixText) +
        bytes.length +
        Buffer.byteLength(suffixText)
      const releaseMultipart = host.budget.reserve(
        'hostAttachmentBytes',
        multipartBytes,
      )
      let multipartOwned = true
      releases.push(() => {
        if (multipartOwned) releaseMultipart()
      })
      let multipart: Buffer
      try {
        multipart = Buffer.allocUnsafe(multipartBytes)
        const offset = multipart.write(prefixText)
        multipart.set(bytes, offset)
        multipart.write(suffixText, offset + bytes.length)
      } catch (error) {
        releaseMultipart()
        throw error
      }
      // Reserve the complete possible mapping before the native upload mutates its store.
      budget.add('nativeFileIds')
      budget.add(
        'nativeFileIdBytes',
        budget.limits.nativeIdBytes + Buffer.byteLength(part.attachmentId),
      )
      let uploadedValue: unknown
      multipartOwned = false
      uploadedValue = await lease.server.http(
        lease.lane,
        '/api/v1/files',
        {
          method: 'POST',
          binary: multipart,
          contentType: `multipart/form-data; boundary=${boundary}`,
          signal,
        },
        {
          release: releaseMultipart,
          abandonedResult: async (value) => {
            const fileId = boundedString(
              object(value).id,
              budget.limits.nativeIdBytes,
            )
            await discard([fileId])
          },
        },
      )
      const result = object(uploadedValue)
      const fileId = boundedString(result.id, budget.limits.nativeIdBytes)
      uploaded.push(fileId)
      if (descriptor.mime.startsWith('image/'))
        content.push({
          type: 'image',
          source: { kind: 'file', file_id: fileId },
        })
      else if (descriptor.mime.startsWith('video/'))
        content.push({
          type: 'video',
          source: { kind: 'file', file_id: fileId },
        })
      else
        content.push({
          type: 'file',
          file_id: fileId,
          name: descriptor.name,
          media_type: descriptor.mime,
          size: bytes.length,
        })
      releaseBytes()
    }
    signal.throwIfAborted()
    return { content, abandon }
  } catch (error) {
    await abandon()
    throw error
  } finally {
    for (const release of releases) release()
  }
}
