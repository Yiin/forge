import type { MessageContent } from '@forge/protocol/message'
import type { HarnessAdapter, SessionConfigOption } from '../harnesses/types.js'
export type { HarnessAdapter }

export type HarnessSession = {
  id: string
  cwd: string
  harness: string
  accountId?: string | null
  providerSessionId?: string | null
}

export type HarnessModel = {
  id: string
  displayName: string
}

export type HarnessItem = MessageContent & {
  itemId?: string
  turnId?: string
}

export type PromptContent =
  | { kind: 'text'; text: string }
  | {
      kind: 'image'
      attachmentId?: string
      mime: string
      bytes: Buffer
      path?: string
    }
  | {
      kind: 'file'
      attachmentId?: string
      path: string
      name: string
      mime: string
    }

export type HarnessHandle = {
  prompt(content: string | PromptContent[]): Promise<void> | void
  steer?(...args: any[]): Promise<unknown> | unknown
  followUp?(...args: any[]): Promise<unknown> | unknown
  cancel(): Promise<void> | void
  kill(): Promise<void> | void
  setModel?(modelId: string): Promise<void> | void
  configOptions?(): SessionConfigOption[]
  setConfigOption?(configId: string, value: string | boolean): Promise<void>
  answerQuestion?(questionId: string, answer: unknown): Promise<void> | void
  availableModels?: HarnessModel[]
}

export type HarnessProcess = {
  spawn(
    session: HarnessSession,
    onItem: (item: HarnessItem) => void,
    onExit: (error?: Error) => void,
  ): Promise<HarnessHandle> | HarnessHandle
  capabilities?: { loadSession: boolean; sessionFork?: boolean }
  loadSession?: (
    session: HarnessSession,
    onItem: (item: HarnessItem) => void,
    onExit: (error?: Error) => void,
  ) => Promise<{
    handle: HarnessHandle
    proven: boolean
    availableModels?: HarnessModel[]
  }>
  fork?: (
    session: HarnessSession,
    onItem: (item: HarnessItem) => void,
    onExit: (error?: Error) => void,
  ) => Promise<{
    handle: HarnessHandle
    proven: boolean
    providerSessionId?: string
    availableModels?: HarnessModel[]
  }>
  newSession?: (
    session: HarnessSession,
    onItem: (item: HarnessItem) => void,
    onExit: (error?: Error) => void,
  ) => Promise<{
    handle: HarnessHandle
    proven: boolean
    availableModels?: HarnessModel[]
  }>
}

export type HarnessFactory = (
  harness: string,
  accountId?: string | null,
) => HarnessProcess
