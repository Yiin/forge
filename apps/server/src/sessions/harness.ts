import type { MessageContent } from '@forge/protocol/message'

export type HarnessSession = {
  id: string
  cwd: string
  harness: string
  providerSessionId?: string | null
}

export type HarnessItem = MessageContent

export type HarnessHandle = {
  prompt(content: string): Promise<void> | void
  cancel(): Promise<void> | void
  kill(): Promise<void> | void
  answerQuestion?(questionId: string, answer: string): Promise<void> | void
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
  ) => Promise<{ handle: HarnessHandle; proven: boolean }>
  fork?: (
    session: HarnessSession,
    onItem: (item: HarnessItem) => void,
    onExit: (error?: Error) => void,
  ) => Promise<{
    handle: HarnessHandle
    proven: boolean
    providerSessionId?: string
  }>
  newSession?: (
    session: HarnessSession,
    onItem: (item: HarnessItem) => void,
    onExit: (error?: Error) => void,
  ) => Promise<{ handle: HarnessHandle; proven: boolean }>
}

export type HarnessFactory = (harness: string) => HarnessProcess
