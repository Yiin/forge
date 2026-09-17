import type {
  KimiAdapterOptions,
  KimiStateReader,
  KimiChildOwner,
} from '../harnesses/kimi/types.js'
import { NativeStorage, sameNativeValue } from './native-storage.js'

type State = Awaited<ReturnType<KimiStateReader>>
export function kimiStorage(
  store: NativeStorage,
  activation: string,
): Pick<KimiAdapterOptions, 'readState' | 'commitRecords'> {
  const scope = (binding: unknown) => {
    store.assertActivation(activation)
    const old = store.get('binding')
    if (old && !sameNativeValue(old, binding))
      throw new Error('Kimi persisted binding changed')
    store.put('binding', binding)
  }
  const read = (): State =>
    store.get<State>('kimi-state') ?? {
      committed: { ordinal: 0 },
      owners: [],
      pending: [],
    }
  return {
    readState: async (input) =>
      store.transaction(input.signal, () => {
        if (input.sessionId !== store.session.id)
          throw new Error('Kimi session mismatch')
        scope(input.binding)
        return read()
      }),
    commitRecords: async (input) =>
      store.transaction(input.signal, () => {
        if (input.scope.sessionId !== store.session.id)
          throw new Error('Kimi session mismatch')
        scope(input.scope.binding)
        const key = `kimi-batch:${input.batchId}`
        const body = {
          scope: input.scope,
          importId: input.importId ?? null,
          contentHash: input.contentHash,
          expectedOrdinal: input.expectedOrdinal,
          expectedCheckpoint: input.expectedCheckpoint ?? null,
          checkpoint: input.checkpoint,
          records: input.records,
          events: input.events,
        }
        const previous = store.find<{ body: typeof body; ordinal: number }>(key)
        if (previous) {
          if (!sameNativeValue(previous.body, body))
            throw new Error('Kimi batch retry changed')
          return { ordinal: previous.ordinal, disposition: 'replayed' as const }
        }
        if (input.replayOnly) throw new Error('Kimi replay batch missing')
        const current = read()
        if (
          current.committed.ordinal !== input.expectedOrdinal ||
          !sameNativeValue(
            current.checkpoint ?? { transcripts: {} },
            input.expectedCheckpoint ?? { transcripts: {} },
          )
        )
          throw new Error('Kimi checkpoint conflict')
        const owners = [...current.owners]
        const pending = new Map(
          current.pending.map((record) => [
            (record.payload as { requestId: string }).requestId,
            record,
          ]),
        )
        for (const record of input.records) {
          store.record(`kimi-record:${record.recordId}`, record)
          const payload = record.payload as Record<string, unknown>
          if (record.kind === 'request.pending')
            pending.set(String(payload.requestId), record)
          else if (
            ['request.submitted', 'request.expired'].includes(record.kind)
          )
            pending.delete(String(payload.requestId))
          if (
            record.root &&
            ['turn.owner', 'child.owner', 'tool.owner'].includes(record.kind)
          ) {
            const owner: State['owners'][number] = {
              agentId: record.agentId ?? 'main',
              sourceIdentity: record.sourceIdentity,
              root: record.root,
              ...(typeof payload.providerTurnId === 'string'
                ? { providerTurnId: payload.providerTurnId }
                : {}),
              ...(typeof payload.providerToolCallId === 'string'
                ? { providerToolCallId: payload.providerToolCallId }
                : {}),
              ...(typeof payload.promptId === 'string'
                ? { providerPromptId: payload.promptId }
                : {}),
              ...(record.kind === 'child.owner'
                ? { child: payload as KimiChildOwner }
                : {}),
            }
            if (!owners.some((value) => sameNativeValue(value, owner)))
              owners.push(owner)
          }
        }
        const ordinal = current.committed.ordinal + 1
        store.record(key, { body, ordinal })
        store.put('kimi-state', {
          checkpoint: input.checkpoint,
          committed: { ordinal },
          owners,
          pending: [...pending.values()],
        })
        return { ordinal, disposition: 'committed' as const }
      }),
  }
}
