import type { HarnessAccount } from '@forge/protocol/accounts'
import type { HarnessConfig } from '@forge/protocol/config'
import type {
  ConfirmedNativeBinding,
  DispatchOptions,
  HarnessAdapter,
  HarnessEvent,
  HarnessHandle,
  HarnessReceipt,
  HarnessSession,
  PromptInput,
} from '../types.js'
import type { KimiLimits } from './limits.js'

export type KimiLaunchAuthority = Readonly<{
  provider: string
  account: Readonly<HarnessAccount>
  harness: Readonly<HarnessConfig>
  credentialPolicy: 'configured-native'
  environment: Readonly<NodeJS.ProcessEnv>
}>
export type KimiPromptAcceptance =
  | {
      status: 'accepted'
      promptId: string
      userMessageId: string
      nativeStatus: 'running' | 'queued' | 'blocked'
    }
  | { status: 'rejected' | 'unknown'; code: string; message: string }
export type KimiDelivery =
  | {
      status: 'delivered'
      mode: 'root' | 'steer'
      promptId: string
      activePromptId: string
      providerTurnId: string
    }
  | { status: 'not_delivered' | 'unknown'; code: string; message: string }
export type KimiReceipt = HarnessReceipt & {
  readonly nativeAcceptance: Promise<KimiPromptAcceptance>
  readonly delivery: Promise<KimiDelivery>
}
export type KimiHandle = Omit<HarnessHandle, 'prompt' | 'steer'> & {
  prompt(
    input: PromptInput[] | string,
    options?: DispatchOptions,
    identity?: { runId: string; turnId: string },
  ): KimiReceipt
  queue(
    input: PromptInput[] | string,
    options?: DispatchOptions,
    identity?: { runId: string; turnId: string },
  ): KimiReceipt
  steer(
    input: PromptInput[] | string,
    options?: DispatchOptions,
    identity?: { runId: string; turnId: string },
  ): KimiReceipt
  steerQueued(receiptIds: readonly string[]): Promise<void>
  abortPrompt(receiptId: string): Promise<void>
  dismissQuestion(requestId: string): Promise<void>
  readonly catalog: KimiCatalog
}
export type KimiAdapterOptions = {
  authority: KimiLaunchAuthority
  host: KimiHost
  loadAttachment?: KimiLoadAttachment
  readState: KimiStateReader
  commitRecords: KimiRecordSink
  storeAttachment: KimiAttachmentSink
  beforeDispatch?: (input: KimiDispatchBoundary) => Promise<void>
  signal?: AbortSignal
}
export type KimiAdapter = Omit<HarnessAdapter, 'spawn' | 'load'> & {
  spawn(
    session: HarnessSession,
    emit: (event: HarnessEvent) => void,
  ): Promise<KimiHandle>
  load(
    session: HarnessSession,
    emit: (event: HarnessEvent) => void,
  ): Promise<KimiHandle>
}
export type KimiCatalog = Readonly<{
  version: '0.34.0'
  models: readonly {
    id: string
    provider: string
    displayName?: string
    contextWindow: number
    capabilities?: readonly string[]
    efforts?: readonly string[]
    defaultEffort?: string
  }[]
  defaultModel?: string
  defaultEffort?: string
  commands: { status: 'unsupported'; reason: string }
}>
export type KimiSessionCursor = Readonly<{ seq: number; epoch: string }>
export type KimiTranscriptCursor = Readonly<{ agentId: string; seq: number }>
export type KimiHistoryCursor = Readonly<{
  nativeSessionId: string
  agentId: string
  source: 'transcript'
  snapshotId: string
  beforeTurn: string
}>
export type KimiMessageCursor = Readonly<{
  nativeSessionId: string
  agentId: 'main'
  source: 'messages'
  snapshotId: string
  beforeId: string
}>
export type KimiRecordScope = Readonly<{
  sessionId: string
  binding: ConfirmedNativeBinding
  runtimeGeneration: string
}>
export type KimiImportScope = Readonly<{ sessionId: string; importId: string }>
export type KimiRoot = {
  runId: string
  turnId: string
  operationId: string
  childId?: string
}
export type KimiNativeRecord = Readonly<{
  recordId: string
  agentId?: string
  providerTurnId?: string
  providerPromptId?: string
  providerItemId?: string
  sourceIdentity: {
    domain:
      'live-engine' | 'live-projection' | 'message' | 'cold-import' | 'local'
    key: string
    revision: string
  }
  root?: KimiRoot
  kind: string
  payload: unknown
  attachmentIds?: readonly string[]
}>
export type KimiChildOwner = {
  providerAgentId: string
  executionId: string
  spawnCursor: KimiSessionCursor
  providerParentAgentId: string
  providerParentToolCallId: string
  childId: string
  parentChildId?: string
  parentToolCallId: string
  runId: string
  turnId: string
  operationId: string
  providerRootTurnId: string
}
export type KimiSteerEdge = {
  sessionId: string
  agentId: 'main'
  epoch: string
  seq: number
  activePromptId: string
  promptIds: readonly string[]
  providerTurnId: string
}
export type KimiCheckpoint = Readonly<{
  session?: KimiSessionCursor
  transcripts: Readonly<Record<string, number>>
  transcriptStores?: Readonly<Record<string, string>>
  history?: KimiHistoryCursor
  messages?: KimiMessageCursor
}>
export type KimiCommittedPosition = Readonly<{ ordinal: number }>
export type KimiStateReader = (input: {
  sessionId: string
  binding: ConfirmedNativeBinding
  signal: AbortSignal
}) => Promise<{
  checkpoint?: KimiCheckpoint
  committed: KimiCommittedPosition
  owners: readonly {
    agentId: string
    providerTurnId?: string
    providerPromptId?: string
    providerToolCallId?: string
    providerItemId?: string
    sourceIdentity: KimiNativeRecord['sourceIdentity']
    root: KimiRoot
    child?: KimiChildOwner
  }[]
  pending: readonly KimiNativeRecord[]
}>
export type KimiRecordSink = (input: {
  scope: KimiRecordScope
  importId?: string
  batchId: string
  /** Stable digest of the immutable batch payload and its checkpoint delta. */
  contentHash: string
  /** Refuse a missing batch. Only an identical durable retry may satisfy this call. */
  replayOnly: boolean
  expectedOrdinal: number
  expectedCheckpoint?: KimiCheckpoint
  checkpoint: KimiCheckpoint
  records: readonly KimiNativeRecord[]
  events: readonly HarnessEvent[]
  signal: AbortSignal
}) => Promise<KimiCommittedPosition & { disposition: 'committed' | 'replayed' }>
export type KimiAttachmentSink = (input: {
  scope: KimiRecordScope
  importId?: string
  agentId: string
  nativeAttachmentId: string
  sourceIdentity: KimiNativeRecord['sourceIdentity']
  nativeFileId?: string
  mime: string
  name?: string
  sizeBytes: number
  sha256: string
  bytes: AsyncIterable<Uint8Array>
  signal: AbortSignal
}) => Promise<{ attachmentId: string }>
export type KimiLoadAttachment = (
  sessionId: string,
  attachmentId: string,
  signal: AbortSignal,
) => Promise<{
  mime: string
  name: string
  path: string
  sizeBytes: number
  readBytes(): Promise<Uint8Array>
}>
export type KimiDispatchBoundary = {
  sessionId: string
  runtimeGeneration: string
  runId: string
  turnId: string
  operationId: string
  cwd: string
  kind: 'prompt' | 'steer'
  signal: AbortSignal
}
export type KimiHostOptions = { limits?: Partial<KimiLimits> }
export type KimiHost = { close(): Promise<void> }

/** Baseline .13 consumer replaces this whole visible subtree at its committed ordinal. */
export type KimiProjectionSnapshot = Readonly<{
  scope: KimiRecordScope
  committed: KimiCommittedPosition
  visible: readonly KimiNativeRecord[]
  removedItemIds: readonly string[]
  unavailableItemIds: readonly string[]
}>
