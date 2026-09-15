/* eslint-disable no-control-regex -- Reject unsafe control bytes in prompt text. */
import { createHash } from 'node:crypto'
import { types } from 'node:util'
import type { ModelListItem, ModelSelection, SDKUserMessage } from '@cursor/sdk'
import {
  dispatchOptionsSchema,
  promptInputSchema,
} from '@forge/protocol/harness'
import type {
  DispatchOptions,
  PromptInput,
  SessionConfigOption,
} from '../types.js'
import type { LoadCursorAttachment } from './contracts.js'
import { boundedId, invariant, plainCopy, type CursorLimits } from './limits.js'

export function cursorPolicy(options: DispatchOptions | undefined) {
  invariant(
    options?.permissionMode === 'auto' || options?.permissionMode === 'yolo',
    'cursor_unsupported_policy',
  )
  invariant(
    options.approvalPolicy == null &&
      options.sandboxPolicy == null &&
      options.serviceTier == null &&
      options.reasoning == null,
    'cursor_unsupported_policy',
  )
  return {
    autoReview: options.permissionMode === 'auto',
    sandboxOptions: { enabled: options.permissionMode === 'auto' },
    enableAgentRetries: false as const,
  }
}
export function captureInput(
  input: PromptInput[] | string,
  options: DispatchOptions | undefined,
  limits: CursorLimits,
) {
  // Raw text and its JSON representation have separate ceilings. JSON can
  // require six bytes per input byte. The control allowance covers part fields.
  const captured = plainCopy<PromptInput[]>(
    typeof input === 'string' ? [{ type: 'text', text: input }] : input,
    6 * limits.promptBytes + limits.controlBytes,
    limits.jsonDepth,
    limits.jsonElements,
  )
  const selection = dispatchOptionsSchema
    .strict()
    .parse(plainCopy(options === undefined ? {} : options, limits.controlBytes))
  cursorPolicy(selection)
  invariant(
    Array.isArray(captured) &&
      captured.length > 0 &&
      captured.length <= limits.parts,
    'cursor_input_parts',
  )
  const parts = captured.map((part) => promptInputSchema.parse(part))
  let images = 0,
    textBytes = 0
  for (const part of parts) {
    invariant(part && typeof part === 'object', 'cursor_invalid_input')
    if (part.type === 'text') {
      invariant(
        typeof part.text === 'string' &&
          !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(part.text),
        'cursor_invalid_input',
      )
      textBytes += Buffer.byteLength(part.text)
    } else if (part.type === 'attachment') {
      boundedId(part.attachmentId)
      invariant(
        ['image/png', 'image/jpeg'].includes(part.mime),
        'cursor_image_mime',
      )
      images++
    } else if (part.type === 'review_reference') {
      const url = new URL(part.url)
      invariant(['http:', 'https:'].includes(url.protocol), 'cursor_review_url')
      textBytes += Buffer.byteLength(part.url + (part.title ?? ''))
    } else invariant(false, 'cursor_invalid_input')
  }
  invariant(
    images <= limits.images && textBytes <= limits.promptBytes,
    'cursor_input_limit',
  )
  return {
    parts,
    options: selection!,
    textBytes,
    imageReservation: images * Math.ceil(limits.imageBytes / 3) * 4,
  }
}
export async function cursorMessage(
  sessionId: string,
  parts: PromptInput[],
  load: LoadCursorAttachment,
  signal: AbortSignal,
  limits: CursorLimits,
): Promise<SDKUserMessage> {
  const text: string[] = [],
    images: NonNullable<SDKUserMessage['images']> = []
  let total = 0
  for (const part of parts) {
    signal.throwIfAborted()
    if (part.type === 'text') text.push(part.text)
    else if (part.type === 'review_reference')
      text.push(`${part.title ?? 'Review'}: ${part.url}`)
    else {
      const attachment = await load(sessionId, part.attachmentId, signal)
      signal.throwIfAborted()
      invariant(
        attachment &&
          typeof attachment === 'object' &&
          !types.isProxy(attachment) &&
          Object.getPrototypeOf(attachment) === Object.prototype,
        'cursor_image_reader',
      )
      const fields = Object.fromEntries(
        ['attachmentId', 'mime', 'size', 'read'].map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(attachment, key)
          invariant(descriptor && 'value' in descriptor, 'cursor_image_reader')
          return [key, descriptor.value]
        }),
      )
      invariant(typeof fields.read === 'function', 'cursor_image_reader')
      invariant(
        fields.attachmentId === part.attachmentId && fields.mime === part.mime,
        'cursor_image_owner',
      )
      invariant(
        Number.isSafeInteger(fields.size) &&
          fields.size > 0 &&
          fields.size <= limits.imageBytes,
        'cursor_image_size',
      )
      const bytes = await fields.read.call(
        attachment,
        limits.imageBytes,
        signal,
      )
      signal.throwIfAborted()
      invariant(
        bytes instanceof Uint8Array && bytes.byteLength === fields.size,
        'cursor_image_size_drift',
      )
      total += bytes.byteLength
      invariant(total <= limits.imageTotalBytes, 'cursor_image_total')
      const buffer = Buffer.from(bytes)
      const valid =
        part.mime === 'image/png'
          ? buffer
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : buffer.length >= 3 &&
            buffer[0] === 255 &&
            buffer[1] === 216 &&
            buffer[2] === 255
      invariant(valid, 'cursor_image_signature')
      images.push({ mimeType: part.mime, data: buffer.toString('base64') })
      text.push(`[Attachment ${images.length}: ${part.attachmentId}]`)
    }
  }
  const message = {
    text: text.join('\n'),
    ...(images.length ? { images } : {}),
  }
  invariant(
    Buffer.byteLength(JSON.stringify(message)) <=
      limits.frameBytes - limits.controlBytes,
    'cursor_input_frame',
  )
  return message
}
export const inputDigest = (message: SDKUserMessage) =>
  createHash('sha256').update(JSON.stringify(message)).digest('hex')
export function validateCatalog(
  value: ModelListItem[],
  limits: CursorLimits,
): ModelListItem[] {
  const items = plainCopy(
    value,
    limits.catalogBytes,
    limits.jsonDepth,
    limits.jsonElements,
  )
  invariant(
    Array.isArray(items) && items.length > 0 && items.length <= limits.models,
    'cursor_catalog_invalid',
  )
  const aliases = new Set<string>()
  for (const item of items) {
    boundedId(item.id)
    invariant(typeof item.displayName === 'string', 'cursor_catalog_invalid')
    for (const id of [item.id, ...(item.aliases ?? [])]) {
      boundedId(id)
      invariant(!aliases.has(id), 'cursor_catalog_duplicate')
      aliases.add(id)
    }
    invariant(
      (item.parameters?.length ?? 0) <= limits.parameters &&
        (item.variants?.length ?? 0) <= limits.variants,
      'cursor_catalog_limit',
    )
    const ids = new Set<string>()
    for (const parameter of item.parameters ?? []) {
      boundedId(parameter.id, 128)
      invariant(
        !ids.has(parameter.id) &&
          parameter.values.length <= limits.parameterValues,
        'cursor_catalog_parameter',
      )
      ids.add(parameter.id)
      const values = new Set<string>()
      for (const option of parameter.values) {
        invariant(
          typeof option.value === 'string' &&
            Buffer.byteLength(option.value) <= 256 &&
            !values.has(option.value),
          'cursor_catalog_value',
        )
        values.add(option.value)
      }
    }
    for (const variant of item.variants ?? [])
      validateModel({ id: item.id, params: variant.params }, [item])
  }
  return items
}
export function validateModel(
  model: ModelSelection,
  items: ModelListItem[],
): ModelSelection {
  const item = items.find(
    (item) => item.id === model.id || item.aliases?.includes(model.id),
  )
  invariant(item, 'cursor_model_unavailable')
  const params = model.params ?? []
  invariant(params.length <= 32, 'cursor_model_parameters')
  const seen = new Set<string>()
  for (const parameter of params) {
    invariant(
      !seen.has(parameter.id) &&
        Buffer.byteLength(parameter.id) <= 128 &&
        Buffer.byteLength(parameter.value) <= 256,
      'cursor_model_parameters',
    )
    seen.add(parameter.id)
    invariant(
      item.parameters
        ?.find((definition) => definition.id === parameter.id)
        ?.values.some((option) => option.value === parameter.value),
      'cursor_model_value',
    )
  }
  return plainCopy(model, 16384)
}
export function modelConfig(
  model: ModelSelection | undefined,
  items: ModelListItem[],
): SessionConfigOption[] {
  const item = items.find(
    (item) => item.id === model?.id || item.aliases?.includes(model?.id ?? ''),
  )
  return (item?.parameters ?? []).map((parameter) => ({
    id: parameter.id,
    name: parameter.displayName ?? parameter.id,
    type: 'select',
    currentValue:
      model?.params?.find((value) => value.id === parameter.id)?.value ?? null,
    options: parameter.values.map((value) => ({
      value: value.value,
      name: value.displayName ?? value.value,
    })),
  }))
}
