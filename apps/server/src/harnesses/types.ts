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
export type CompletionResult =
  | { status: 'completed'; runId: string; turnId: string }
  | { status: 'interrupted'; runId: string; turnId: string; reason?: string }
  | {
      status: 'failed'
      runId: string
      turnId: string
      code: string
      message: string
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
  let settle!: (result: CompletionResult) => void
  const promise = new Promise<CompletionResult>((resolve) => {
    settle = resolve
  }) as CompletionHandle
  Object.assign(promise, ids)
  return { handle: promise, settle }
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
