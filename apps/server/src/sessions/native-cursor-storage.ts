import type {
  CursorDurableSink,
  CursorOwner,
  CursorReservation,
} from '../harnesses/cursor/contracts.js'
import { NativeStorage, sameNativeValue } from './native-storage.js'

export function cursorStorage(
  store: NativeStorage,
  activation: string,
): CursorDurableSink {
  const check = (owner: CursorOwner) => {
    store.assertActivation(activation)
    if (
      owner.forgeSessionId !== store.session.id ||
      owner.provider !== store.session.provider ||
      owner.accountId !== store.session.accountId ||
      owner.cwd !== store.session.cwd
    )
      throw new Error('Cursor storage owner mismatch')
    const reservation = store.get<CursorReservation>('cursor-reservation')
    if (reservation && reservation.creationOwner.storeId !== owner.storeId)
      throw new Error('Cursor storage identity changed')
  }
  const ownerKey = (owner: CursorOwner) => JSON.stringify(owner)
  return {
    reserve: async (input, signal) =>
      store.transaction(signal, () => {
        check(input.creationOwner)
        const old = store.get<CursorReservation>('cursor-reservation')
        if (
          old &&
          !sameNativeValue(old, input) &&
          !(
            old.state === 'reserved' &&
            input.state === 'creation-started' &&
            sameNativeValue({ ...old, state: input.state }, input)
          )
        )
          throw new Error('Cursor reservation conflict')
        store.put('cursor-reservation', input)
        return input
      }),
    readSession: async (id, signal) =>
      store.transaction(signal, () => {
        store.assertActivation(activation)
        if (id !== store.session.id) throw new Error('Cursor session mismatch')
        return store.get<CursorReservation>('cursor-reservation') ?? null
      }),
    confirm: async (input, signal) =>
      store.transaction(signal, () => {
        check(input.owner)
        const old = store.get<CursorReservation>('cursor-reservation')
        if (
          !old ||
          old.reservationId !== input.record.reservationId ||
          old.storeRelativePath !== input.record.storeRelativePath
        )
          throw new Error('Cursor confirmation mismatch')
        if (old.record && !sameNativeValue(old.record, input.record))
          throw new Error('Cursor binding changed')
        store.put('cursor-reservation', {
          ...old,
          state: 'native-confirmed',
          record: input.record,
          ...(input.initialQueuedRunId
            ? { initialQueuedRunId: input.initialQueuedRunId }
            : {}),
        })
        store.put('binding', input.record.binding)
      }),
    markDirty: async (input, signal) =>
      store.transaction(signal, () => {
        check(input.owner)
        const old = store.get<CursorReservation>('cursor-reservation')
        if (!old) throw new Error('Cursor reservation missing')
        store.put('cursor-reservation', { ...old, state: 'dirty' })
        store.put('cursor-dirty-reason', input.code)
      }),
    appendNative: async (record, signal) =>
      store.transaction(signal, () => {
        check(record.owner)
        const key = ownerKey(record.owner)
        const result = store.record(`cursor:${key}:${record.sourceSeq}`, record)
        const prior = store.get<number>(`cursor-through:${key}`) ?? 0
        store.put(`cursor-through:${key}`, Math.max(prior, result.position))
        return { position: result.position }
      }),
    seal: async (owner, signal) =>
      store.transaction(signal, () => {
        check(owner)
        return {
          through: store.get<number>(`cursor-through:${ownerKey(owner)}`) ?? 0,
        }
      }),
    flush: async ({ owner, through }, signal) =>
      store.transaction(signal, () => {
        check(owner)
        const committed =
          store.get<number>(`cursor-through:${ownerKey(owner)}`) ?? 0
        if (committed !== through)
          throw new Error('Cursor completion frontier changed')
        return { committedThrough: committed }
      }),
  }
}
