import type {
  PiAdapterOptions,
  PiHistoryCursor,
  ConfirmedPiBinding,
} from '../harnesses/pi/index.js'
import { bindingFromState } from '../harnesses/pi/session.js'
import { NativeStorage, sameNativeValue } from './native-storage.js'

export function piStorage(
  store: NativeStorage,
  activation: string,
): Pick<
  PiAdapterOptions,
  'persistRecord' | 'persistSnapshot' | 'commitHistoryPage'
> {
  const check = (sessionId: string) => {
    store.assertActivation(activation)
    if (sessionId !== store.session.id)
      throw new Error('Pi persistence owner mismatch')
  }
  const binding = (value: ConfirmedPiBinding) => {
    const old = store.get<ConfirmedPiBinding>('binding')
    if (old && !sameNativeValue(old, value))
      throw new Error('Pi persisted binding changed')
    store.put('binding', value)
  }
  return {
    persistRecord: async (owner, nativeBinding, record, signal) =>
      store.transaction(signal, () => {
        check(owner.forgeSessionId)
        binding(nativeBinding)
        store.record(`pi:${JSON.stringify(record.source)}`, record)
      }),
    persistSnapshot: async (owner, snapshot, signal) =>
      store.transaction(signal, () => {
        check(owner.forgeSessionId)
        store.put(`pi-${snapshot.kind}`, snapshot.value)
        if (snapshot.kind === 'state')
          binding(bindingFromState(store.session, snapshot.value))
      }),
    commitHistoryPage: async (owner, nativeBinding, input, signal) =>
      store.transaction(signal, () => {
        check(owner.forgeSessionId)
        binding(nativeBinding)
        const key = `pi-history:${owner.importOperationId}`
        const prior = store.get<PiHistoryCursor>(key) ?? null
        const recordKey = `${key}:${JSON.stringify(input.expected)}`
        const old = store.find(recordKey)
        if (old) {
          if (!sameNativeValue(old, input))
            throw new Error('Pi history retry changed')
          return
        }
        if (!sameNativeValue(prior, input.expected))
          throw new Error('Pi history cursor conflict')
        for (const record of input.page.records)
          store.record(`pi:${JSON.stringify(record.source)}`, record)
        store.record(recordKey, input)
        store.put(key, input.page.end)
      }),
  }
}
