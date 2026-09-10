import { completionResultSchema } from '@forge/protocol/harness'
import type {
  AdapterKind,
  HarnessCapabilities,
  HarnessEvent,
  DispatchOptions,
  ModelOptions,
  NativeBinding,
  PromptInput,
  QuestionAnswer,
  PermissionReply,
  CompletionResult,
} from '@forge/protocol/harness'

export type {
  AdapterKind,
  HarnessCapabilities,
  HarnessEvent,
  ModelOptions,
  NativeBinding,
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
  currentValue: string | boolean
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
export function createCompletionHandle(ids: {
  completionId: string
  runId: string
  turnId: string
}) {
  let resolve!: (result: CompletionResult) => void
  const promise = new Promise<CompletionResult>((complete) => {
    resolve = complete
  }) as CompletionHandle
  Object.assign(promise, ids)
  return {
    handle: promise,
    settle(result: CompletionResult) {
      const parsed = completionResultSchema.parse(result)
      if (parsed.runId !== promise.runId || parsed.turnId !== promise.turnId) {
        throw new Error('Completion result does not match the handle identity')
      }
      resolve(parsed)
    },
  }
}
export type HarnessHandle = {
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
