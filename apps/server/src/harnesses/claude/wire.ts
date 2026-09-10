import { z } from 'zod'
import type {
  HarnessEvent,
  QuestionAnswer,
  QuestionRequest,
} from '@forge/protocol/harness'

export const MiB = 1024 * 1024
export const LIMITS = Object.freeze({
  controls: 64,
  interactions: 64,
  interactionBytes: 8 * MiB,
  messages: 32,
  blocks: 128,
  textBytes: 8 * MiB,
  blockBytes: 2 * MiB,
  messageBytes: 4 * MiB,
  tasks: 256,
  identities: 4096,
  frames: 8192,
  stringBytes: 64 * 1024,
  identityBytes: 4 * MiB,
  frameBytes: 2 * MiB,
  attributionFrames: 256,
  attributionBytes: 4 * MiB,
  operations: 16,
})
export type ObjectValue = Record<string, unknown>
export function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Claude sent an invalid object')
  return value as ObjectValue
}
export function maybeObject(value: unknown): ObjectValue {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : {}
}
export function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
export function requiredString(value: unknown): string {
  const result = string(value)
  if (!result.trim()) throw new Error('Claude omitted a required identity')
  return result
}
export type Owner = { runId: string; turnId: string; childId?: string }
type WithoutEnvelope<T> = T extends unknown
  ? Omit<T, 'runId' | 'turnId' | 'runtimeGeneration' | 'deliveryId' | 'childId'>
  : never
export type EventBody = WithoutEnvelope<HarnessEvent>
export type EmitItem = (owner: Owner, body: EventBody) => void

/** Required ownership identities never evict. Recent wire UUIDs use a separate cache. */
export class Identities {
  private readonly values = new Set<string>()
  private bytes = 0
  add(...keys: string[]) {
    const added = new Set<string>()
    let bytes = 0
    for (const key of keys) {
      if (this.values.has(key) || added.has(key)) continue
      if (this.values.size + added.size >= LIMITS.identities)
        throw new Error('Claude identity limit exceeded')
      const keyBytes = Buffer.byteLength(key)
      if (
        keyBytes > LIMITS.stringBytes ||
        this.bytes + bytes + keyBytes > LIMITS.identityBytes
      )
        throw new Error('Claude identity byte limit exceeded')
      added.add(key)
      bytes += keyBytes
    }
    for (const key of added) this.values.add(key)
    this.bytes += bytes
  }
  clear() {
    this.values.clear()
    this.bytes = 0
  }
  get retainedBytes() {
    return this.bytes
  }
  get size() {
    return this.values.size
  }
}

const modelSchema = z.object({
  value: z.string().min(1),
  resolvedModel: z.string().optional(),
  displayName: z.string(),
  description: z.string().optional(),
  supportsEffort: z.boolean().optional(),
  supportedEffortLevels: z.array(z.string()).max(16).optional(),
  supportsAdaptiveThinking: z.boolean().optional(),
  supportsFastMode: z.boolean().optional(),
  supportsAutoMode: z.boolean().optional(),
})
const commandSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  argumentHint: z.string().optional(),
  aliases: z.array(z.string()).max(128).optional(),
})
const catalogSchema = z.object({
  models: z.array(modelSchema).max(512),
  commands: z.array(commandSchema).max(2048),
})
export type ClaudeCatalog = z.infer<typeof catalogSchema>
export function parseCatalog(value: unknown): ClaudeCatalog {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 2 * MiB)
    throw new Error('Claude catalog limit exceeded')
  const result = catalogSchema.safeParse(value)
  if (!result.success)
    throw new Error('Claude initialize response has an invalid catalog')
  return result.data
}
export function successResponse(requestId: string, response: unknown) {
  return {
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response },
  }
}
export function denyResponse(message = 'The user denied this tool.') {
  return { behavior: 'deny', message }
}

export function questionRequest(
  requestId: string,
  input: ObjectValue,
): QuestionRequest {
  if (
    !Array.isArray(input.questions) ||
    input.questions.length === 0 ||
    input.questions.length > 32
  )
    throw new Error('Claude sent invalid questions')
  const texts = new Set<string>()
  const questions = input.questions.map((value, index) => {
    const q = object(value)
    const question = requiredString(q.question)
    if (texts.has(question))
      throw new Error('Claude sent duplicate question text')
    texts.add(question)
    if (!Array.isArray(q.options) || q.options.length > 64)
      throw new Error('Claude sent invalid question options')
    const labels = new Set<string>()
    const id = `${requestId}:q${index}`
    const options = q.options.map((value, index) => {
      const option = object(value)
      const label = requiredString(option.label)
      if (labels.has(label))
        throw new Error('Claude sent duplicate option labels')
      labels.add(label)
      return {
        id: `${id}:o${index}`,
        label,
        ...(typeof option.description === 'string'
          ? { description: option.description }
          : {}),
      }
    })
    return {
      id,
      question,
      ...(typeof q.header === 'string' ? { header: q.header } : {}),
      options,
      multiSelect: q.multiSelect === true,
      allowFreeInput: true,
    }
  })
  return { requestId, isBlocking: true, questions }
}
export function answerQuestions(
  request: QuestionRequest,
  input: ObjectValue,
  answers: Record<string, QuestionAnswer>,
): ObjectValue {
  if (
    Object.keys(answers).some(
      (key) => !request.questions.some((q) => q.id === key),
    )
  )
    throw new Error('Unknown question ID')
  const nativeAnswers: Record<string, string> = Object.create(null)
  const annotations: ObjectValue = Object.assign(
    Object.create(null),
    maybeObject(input.annotations),
  )
  let skipped = false
  for (const q of request.questions) {
    const answer = answers[q.id]
    if (!answer) throw new Error('An answer is required for every question')
    if (answer.type === 'skipped') {
      skipped = true
      continue
    }
    if (answer.type === 'free_text') {
      if (!answer.text.trim()) throw new Error('Question text cannot be empty')
      nativeAnswers[q.question] = answer.text
    } else if (
      answer.type === 'selected' ||
      answer.type === 'selected_with_text'
    ) {
      if (
        !answer.optionIds.length ||
        (!q.multiSelect && answer.optionIds.length !== 1) ||
        new Set(answer.optionIds).size !== answer.optionIds.length
      )
        throw new Error('Invalid question selection count')
      nativeAnswers[q.question] = answer.optionIds
        .map((id) => {
          const option = q.options.find((option) => option.id === id)
          if (!option) throw new Error('Unknown question option ID')
          return option.label
        })
        .join(', ')
      if (answer.type === 'selected_with_text')
        annotations[q.question] = {
          ...maybeObject(annotations[q.question]),
          notes: answer.text,
        }
    } else throw new Error('Invalid question answer')
  }
  if (skipped) return denyResponse('The user skipped this question request.')
  return {
    behavior: 'allow',
    updatedInput: {
      ...input,
      answers: nativeAnswers,
      ...(Object.keys(annotations).length ? { annotations } : {}),
    },
  }
}
