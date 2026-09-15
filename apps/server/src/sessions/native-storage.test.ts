import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { afterEach, expect, it } from 'vitest'
import { NativeStorage } from './native-storage.js'
import { cursorStorage } from './native-cursor-storage.js'
import { kimiStorage } from './native-kimi-storage.js'
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
function fixture() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  db.exec(
    "CREATE TABLE sessions(id TEXT PRIMARY KEY, harness TEXT, account_id TEXT, cwd TEXT, deleted_at INTEGER); INSERT INTO sessions VALUES ('session', 'kimi', 'account', '/workspace', NULL)",
  )
  db.exec(
    readFileSync(
      new URL(
        '../../drizzle/0027_native_provider_records.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  )
  const session = {
    id: 'session',
    provider: 'kimi',
    accountId: 'account',
    cwd: '/workspace',
  }
  const store = new NativeStorage(db, session)
  return {
    db,
    store,
    session,
    activation: store.activate(),
    signal: new AbortController().signal,
  }
}
it('retains exact retry positions and rolls back failed multi-record commits', () => {
  const f = fixture()
  const first = f.store.transaction(f.signal, () =>
    f.store.record('first', { text: 'one' }),
  )
  expect(f.store.record('first', { text: 'one' })).toEqual({
    ...first,
    replayed: true,
  })
  expect(() => f.store.record('first', { text: 'changed' })).toThrow('conflict')
  expect(() =>
    f.store.transaction(f.signal, () => {
      f.store.record('second', {})
      throw Error('refuse')
    }),
  ).toThrow('refuse')
  expect(f.store.find('second')).toBeUndefined()
  f.store.activate()
  expect(() => f.store.assertActivation(f.activation)).toThrow('expired')
  f.db.prepare("UPDATE sessions SET account_id = 'foreign'").run()
  expect(() => f.store.get('activation')).toThrow('authority')
})
it('Kimi atomically preserves checkpoint and outbox with exact retry refusal', async () => {
  const f = fixture(),
    sink = kimiStorage(f.store, f.activation)
  const binding = {
    provider: 'kimi',
    accountId: 'account',
    cwd: '/workspace',
    providerSessionId: 'native',
  }
  const input = {
    scope: { sessionId: 'session', binding, runtimeGeneration: 'generation' },
    batchId: 'batch',
    contentHash: 'digest',
    replayOnly: false,
    expectedOrdinal: 0,
    checkpoint: { transcripts: { main: 1 } },
    records: [
      {
        recordId: 'tool-owner',
        agentId: 'main',
        providerPromptId: undefined,
        sourceIdentity: {
          domain: 'live-engine' as const,
          key: 'frame',
          revision: '1',
        },
        root: {
          runId: 'run',
          turnId: 'turn',
          operationId: 'operation',
          childId: undefined,
        },
        kind: 'tool.owner',
        payload: {
          providerTurnId: 'native-turn',
          providerToolCallId: 'native-tool',
          optional: undefined,
        },
      },
    ],
    events: [],
    signal: f.signal,
  }
  expect(await sink.commitRecords(input)).toEqual({
    ordinal: 1,
    disposition: 'committed',
  })
  expect(await sink.commitRecords({ ...input, replayOnly: true })).toEqual({
    ordinal: 1,
    disposition: 'replayed',
  })
  await expect(
    sink.commitRecords({ ...input, contentHash: 'changed' }),
  ).rejects.toThrow('changed')
  await expect(
    sink.commitRecords({ ...input, batchId: 'missing', replayOnly: true }),
  ).rejects.toThrow('missing')
  await expect(
    sink.commitRecords({ ...input, batchId: 'second' }),
  ).rejects.toThrow('checkpoint')
  const restored = await kimiStorage(f.store, f.activation).readState({
    sessionId: 'session',
    binding,
    signal: f.signal,
  })
  expect(restored.committed.ordinal).toBe(1)
  expect(restored.owners).toEqual([
    {
      agentId: 'main',
      sourceIdentity: input.records[0]!.sourceIdentity,
      root: { runId: 'run', turnId: 'turn', operationId: 'operation' },
      providerTurnId: 'native-turn',
      providerToolCallId: 'native-tool',
    },
  ])
})
it('Cursor rejects a changed reservation and foreign owner without advancing the sealed prefix', async () => {
  const f = fixture(),
    sink = cursorStorage(f.store, f.activation)
  const owner = {
    forgeSessionId: 'session',
    provider: 'kimi',
    accountId: 'account',
    cwd: '/workspace',
    storeId: 'store',
    generation: 'g',
    attemptId: 'a',
    runId: 'r',
    turnId: 't',
  }
  const reservation = {
    version: 1 as const,
    reservationId: 'reservation',
    creationOwner: owner,
    sdkVersion: '1.0.28' as const,
    storeRelativePath: 'sessions/store/sdk',
    state: 'reserved' as const,
  }
  await sink.reserve(reservation, f.signal)
  await sink.reserve({ ...reservation, state: 'creation-started' }, f.signal)
  await expect(
    sink.reserve({ ...reservation, reservationId: 'changed' }, f.signal),
  ).rejects.toThrow('conflict')
  const record = {
    v: 1 as const,
    owner,
    sourceSeq: 1,
    deliveryId: 'd',
    kind: 'terminal' as const,
    payload: {},
  }
  const ack = await sink.appendNative(record, f.signal)
  expect(await sink.appendNative(record, f.signal)).toEqual(ack)
  await expect(
    sink.appendNative(
      { ...record, owner: { ...owner, accountId: 'other' } },
      f.signal,
    ),
  ).rejects.toThrow('owner')
  expect(await sink.seal(owner, f.signal)).toEqual({ through: ack.position })
  expect(await sink.flush({ owner, through: ack.position }, f.signal)).toEqual({
    committedThrough: ack.position,
  })
})
