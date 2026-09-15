import type { HarnessConfig } from '@forge/protocol/config'
import type { HarnessAccount } from '@forge/protocol/accounts'
import type { ModelListItem } from '@cursor/sdk'
import type { ConfirmedNativeBinding } from '../types.js'
import type { BoundedJson, CursorLimits, CursorResources } from './limits.js'
export type CursorSelectedRecords = Readonly<{
  provider: string
  harness: HarnessConfig
  account: HarnessAccount
  selectionEpoch: string
  credential:
    { type: 'sdk-file'; path: string } | { type: 'api-key'; apiKey: string }
  backendUrl?: string
  accountEnv: Readonly<Record<string, string | undefined>>
  settingSources: readonly ('project' | 'user' | 'team' | 'mdm' | 'plugins')[]
}>
export type CursorOwner = Readonly<{
  forgeSessionId: string
  provider: string
  accountId: string
  cwd: string
  storeId: string
  generation: string
  attemptId: string
  runId: string
  turnId: string
}>
export type CursorNativeRecord = Readonly<{
  version: 1
  forgeSessionId: string
  binding: ConfirmedNativeBinding
  sdkVersion: '1.0.28'
  storeId: string
  storeRelativePath: string
  reservationId: string
}>
export type CursorReservation = Readonly<{
  version: 1
  reservationId: string
  creationOwner: CursorOwner
  sdkVersion: '1.0.28'
  storeRelativePath: string
  state: 'reserved' | 'creation-started' | 'native-confirmed' | 'dirty'
  record?: CursorNativeRecord
  initialQueuedRunId?: string
}>
export type CursorNativeEnvelope = Readonly<{
  v: 1
  owner: CursorOwner
  sourceSeq: number
  deliveryId: string
  kind: 'summary' | 'tool-record' | 'sdk-record' | 'terminal' | 'diagnostic'
  payload: BoundedJson
}>
/** Consumers must fence every transaction by reservation, generation, and attempt. */
export type CursorDurableSink = {
  reserve(
    input: CursorReservation,
    signal: AbortSignal,
  ): Promise<CursorReservation>
  readSession(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<CursorReservation | null>
  confirm(
    input: {
      owner: CursorOwner
      record: CursorNativeRecord
      initialQueuedRunId?: string
    },
    signal: AbortSignal,
  ): Promise<void>
  markDirty(
    input: { owner: CursorOwner; code: string },
    signal: AbortSignal,
  ): Promise<void>
  appendNative(
    record: CursorNativeEnvelope,
    signal: AbortSignal,
  ): Promise<{ position: number }>
  seal(owner: CursorOwner, signal: AbortSignal): Promise<{ through: number }>
  flush(
    input: { owner: CursorOwner; through: number },
    signal: AbortSignal,
  ): Promise<{ committedThrough: number }>
}
export type LoadCursorAttachment = (
  sessionId: string,
  attachmentId: string,
  signal: AbortSignal,
) => Promise<{
  attachmentId: string
  mime: string
  size: number
  read: (maximumBytes: number, signal: AbortSignal) => Promise<Uint8Array>
}>
export type CursorAdapterOptions = {
  selected: CursorSelectedRecords
  stateRoot: string
  resources: CursorResources
  sink: CursorDurableSink
  loadAttachment: LoadCursorAttachment
  limits?: Partial<CursorLimits>
}
export type CursorReadiness = {
  sdk: 'ready' | 'missing' | 'invalid'
  auth:
    | 'missing'
    | 'stored-unverified'
    | 'configured-unverified'
    | 'verified'
    | 'failed'
  store: 'new' | 'validated' | 'unavailable'
  processContainer: 'not-started' | 'verified' | 'unavailable' | 'dirty'
  localRuntime: 'not-started' | 'initialized' | 'failed'
  sandbox: 'not-checked' | 'ready' | 'failed'
}
export type CursorCatalogState = {
  status: 'unloaded' | 'ready' | 'stale' | 'failed'
  items: ModelListItem[]
  error?: { code: string; message: string }
}
