import type {
  AdapterKind,
  HarnessCapabilities,
  HarnessEvent,
  ModelOptions,
  NativeBinding,
  PromptInput,
} from '@forge/protocol/harness'

export type {
  AdapterKind,
  HarnessCapabilities,
  HarnessEvent,
  ModelOptions,
  NativeBinding,
  PromptInput,
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
}
export type HarnessHandle = {
  prompt(
    input: PromptInput[] | string,
  ): Promise<HarnessReceipt> | HarnessReceipt
  steer?(
    input: PromptInput[] | string,
  ): Promise<HarnessReceipt> | HarnessReceipt
  cancel(): Promise<void> | void
  kill(): Promise<void> | void
  replyPermission?(requestId: string, optionId: string): Promise<void> | void
  replyQuestion?(
    requestId: string,
    answers: Record<string, string[]>,
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
