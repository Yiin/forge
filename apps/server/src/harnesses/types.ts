import {
  completionResultSchema,
  completionIdentityIdSchema,
  completionFailureProjectionSchema,
  completionProjectionPreflight,
} from '@forge/protocol/harness'
import type {
  AdapterKind,
  HarnessCapabilities,
  HarnessEvent,
  DispatchOptions,
  ModelOptions,
  NativeBinding,
  ConfirmedNativeBinding,
  PromptInput,
  QuestionAnswer,
  PermissionReply,
  CompletionResult,
  CompletionFailureCode,
  CompletionFailureProjection,
} from '@forge/protocol/harness'

export type {
  AdapterKind,
  HarnessCapabilities,
  HarnessEvent,
  ModelOptions,
  NativeBinding,
  ConfirmedNativeBinding,
  PromptInput,
  DispatchOptions,
  QuestionAnswer,
  PermissionReply,
  CompletionResult,
}
export type SessionConfigOption = {
  id: string
  name: string
  type: 'select' | 'boolean'
  currentValue: string | boolean | null
  options?:
    | Array<{ value: string; name: string; description?: string }>
    | Array<{
        group: string
        name: string
        options: Array<{ value: string; name: string; description?: string }>
      }>
  description?: string
  category?: string
}

export type HarnessSession = {
  id: string
  cwd: string
  provider: string
  accountId?: string | null
  binding?: NativeBinding | null
}
export type HarnessReceipt = {
  receiptId: string
  runId: string
  turnId: string
  completion: CompletionHandle
}
export type CompletionHandle = Promise<CompletionResult> & {
  completionId: string
  runId: string
  turnId: string
}
export interface CompletionPersistenceFailure extends Error {
  readonly code: CompletionFailureCode
  readonly completionId: string
  readonly runId: string
  readonly turnId: string
  readonly persistence: CompletionFailureProjection
}
export type CompletionProducer = {
  handle: CompletionHandle
  settle(result: CompletionResult): void
}
export type RejectingCompletionProducer = CompletionProducer & {
  reject(error: CompletionPersistenceFailure): void
}
type CompletionIds = {
  completionId: string
  runId: string
  turnId: string
}
function ownValue(value: object, key: string, immutable = false) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (
    !descriptor ||
    !('value' in descriptor) ||
    (immutable && (descriptor.writable || descriptor.configurable))
  )
    throw new Error('Invalid completion data property')
  return descriptor.value as unknown
}
function deeplyFrozen(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true
  if (!Object.isFrozen(value)) return false
  return Reflect.ownKeys(value).every((key) =>
    deeplyFrozen(Object.getOwnPropertyDescriptor(value, key)!.value),
  )
}
export function isCompletionPersistenceFailure(
  value: unknown,
): value is CompletionPersistenceFailure {
  try {
    if (!(value instanceof Error)) return false
    const code = ownValue(value, 'code', true),
      completionId = ownValue(value, 'completionId', true),
      runId = ownValue(value, 'runId', true),
      turnId = ownValue(value, 'turnId', true),
      persistence = ownValue(value, 'persistence', true)
    completionProjectionPreflight(persistence)
    if (!deeplyFrozen(persistence)) return false
    const parsed = completionFailureProjectionSchema.parse(persistence)
    return (
      parsed.code === code &&
      parsed.completionId === completionId &&
      parsed.runId === runId &&
      parsed.turnId === turnId
    )
  } catch {
    return false
  }
}
export function createCompletionHandle(
  ids: CompletionIds,
  options: { persistenceRejection: true },
): RejectingCompletionProducer
export function createCompletionHandle(ids: CompletionIds): CompletionProducer
export function createCompletionHandle(
  ids: CompletionIds,
  options?: { persistenceRejection: true },
): CompletionProducer | RejectingCompletionProducer {
  if (!ids || typeof ids !== 'object')
    throw new Error('Invalid completion identity')
  const completionId = completionIdentityIdSchema.parse(
      ownValue(ids, 'completionId'),
    ),
    runId = completionIdentityIdSchema.parse(ownValue(ids, 'runId')),
    turnId = completionIdentityIdSchema.parse(ownValue(ids, 'turnId'))
  let resolve!: (result: CompletionResult) => void
  let reject!: (error: CompletionPersistenceFailure) => void
  let settled = false
  const promise = new Promise<CompletionResult>((complete, fail) => {
    resolve = complete
    reject = fail
  }) as CompletionHandle
  Object.assign(promise, { completionId, runId, turnId })
  const producer: CompletionProducer = {
    handle: promise,
    settle(result: CompletionResult) {
      const parsed = completionResultSchema.parse(result)
      if (parsed.runId !== runId || parsed.turnId !== turnId) {
        throw new Error('Completion result does not match the handle identity')
      }
      if (settled) return
      settled = true
      resolve(parsed)
    },
  }
  if (!options?.persistenceRejection) return producer
  void promise.catch(() => {})
  return {
    ...producer,
    reject(error: CompletionPersistenceFailure) {
      if (
        !isCompletionPersistenceFailure(error) ||
        error.completionId !== completionId ||
        error.runId !== runId ||
        error.turnId !== turnId
      )
        throw new Error('Completion failure does not match the handle identity')
      if (settled) return
      settled = true
      reject(error)
    },
  }
}
export type HarnessHandle = {
  /**
   * Read the adapter's confirmed binding through a getter. Null means unconfirmed.
   * A generated ID or an initialize response without session identity is insufficient.
   * Update the getter before emitting events from the confirming native frame.
   * Failed resume must preserve the caller's persisted binding and never publish a replacement.
   */
  readonly binding: ConfirmedNativeBinding | null
  prompt(
    input: PromptInput[] | string,
    options?: DispatchOptions,
    identity?: { runId: string; turnId: string },
  ): Promise<HarnessReceipt> | HarnessReceipt
  steer?(
    input: PromptInput[] | string,
    options?: DispatchOptions,
    identity?: { runId: string; turnId: string },
  ): Promise<HarnessReceipt> | HarnessReceipt
  cancel(): Promise<void> | void
  kill(): Promise<void> | void
  replyPermission?(reply: PermissionReply): Promise<void> | void
  replyQuestion?(
    requestId: string,
    answers: Record<string, QuestionAnswer>,
  ): Promise<void> | void
  setModel?(modelId: string): Promise<void> | void
  configOptions?(): SessionConfigOption[]
  setConfigOption?(configId: string, value: string | boolean): Promise<void>
  availableModels?: { id: string; displayName: string }[]
}
/**
 * The engine buffers events until spawn/load returns, then reads handle.binding before draining them.
 * It also reads the getter before processing each later event.
 * Confirmation after return without an event remains unseen until another event arrives.
 */
export type HarnessAdapter = {
  kind: AdapterKind
  capabilities: HarnessCapabilities
  spawn(
    session: HarnessSession,
    emit: (event: HarnessEvent) => void,
  ): Promise<HarnessHandle> | HarnessHandle
  load?(
    session: HarnessSession,
    emit: (event: HarnessEvent) => void,
  ): Promise<HarnessHandle> | HarnessHandle
}
export type HarnessFactory = (
  provider: string,
  accountId?: string | null,
) => HarnessAdapter
