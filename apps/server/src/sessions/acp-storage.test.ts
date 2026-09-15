import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { afterEach, expect, it } from 'vitest'
import { createAcpStorage } from './acp-storage.js'
import { AcpJournal, type AcpControlOwner } from '../harnesses/acp/ingestion.js'
import { AcpResourceHost } from '../harnesses/acp/limits.js'
import { createHash } from 'node:crypto'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
function fixture() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  db.exec(
    "CREATE TABLE sessions(id TEXT PRIMARY KEY,harness TEXT,account_id TEXT,cwd TEXT,deleted_at INTEGER,provider_session_id TEXT); INSERT INTO sessions VALUES ('session','custom',NULL,'/workspace',NULL,NULL)",
  )
  db.exec('CREATE TABLE messages(seq INTEGER, session_id TEXT, content TEXT)')
  for (const file of [
    '0027_native_provider_records.sql',
    '0028_acp_journals.sql',
  ])
    db.exec(
      readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), 'utf8'),
    )
  const session = {
    id: 'session',
    provider: 'custom',
    accountId: null,
    cwd: '/workspace',
  }
  const store = createAcpStorage(db, session)
  const account = { kind: 'native-default' as const, configurationId: 'config' }
  const input = {
    sessionId: session.id,
    providerInstanceId: session.provider,
    account,
    expectedBinding: null,
  }
  const signal = new AbortController().signal
  const owner: AcpControlOwner = {
    ...input,
    phase: 'control',
    runtimeGeneration: 'runtime',
    startupId: 'startup',
  }
  return { db, store, session, input, signal, owner }
}

it('commits exact journal prefixes and resumes the durable frontier with a fresh writer epoch', async () => {
  const f = fixture()
  const writer = await f.store.ingestion.open(f.input, f.signal)
  await expect(f.store.ingestion.open(f.input, f.signal)).rejects.toThrow(
    'already',
  )
  const journal = new AcpJournal(writer, {
    host: new AcpResourceHost(),
    instanceId: 'custom',
    onFailure() {},
  })
  const first = journal.reserve(f.owner, {
    producerTicket: 'first',
    kind: 'local',
  })
  first.finish([{ value: { kind: 'disposition', status: 'ignored' } }])
  await first.committed
  const tx = f.db.prepare('SELECT value FROM acp_transactions').get() as {
    value: string
  }
  const committed = await writer.commit(JSON.parse(tx.value), f.signal)
  expect(committed.throughOrdinal).toBe(1)
  await journal.close()
  const next = await createAcpStorage(f.db, f.session).ingestion.open(
    f.input,
    f.signal,
  )
  expect(next.journalId).toBe(writer.journalId)
  expect(next.writerEpoch).not.toBe(writer.writerEpoch)
  expect(next.committedThrough).toBe(1)
  expect(next.prefixHash).toBe(committed.prefixHash)
  await expect(writer.commit(JSON.parse(tx.value), f.signal)).rejects.toThrow(
    'closed',
  )
  await next.close()
})

it('rolls back records and binding on an original SQLite commit refusal', async () => {
  const f = fixture()
  const writer = await f.store.ingestion.open(f.input, f.signal)
  f.db.exec(
    "CREATE TRIGGER refuse_transaction BEFORE INSERT ON acp_transactions BEGIN SELECT RAISE(ABORT,'original refusal'); END",
  )
  const journal = new AcpJournal(writer, {
    host: new AcpResourceHost(),
    instanceId: 'custom',
    onFailure() {},
  })
  const ticket = journal.reserve(f.owner, {
    producerTicket: 'binding',
    kind: 'local',
  })
  ticket.finish([
    {
      value: {
        kind: 'binding',
        binding: {
          provider: 'custom',
          accountId: null,
          cwd: '/workspace',
          providerSessionId: 'native',
        },
      },
    },
  ])
  await expect(ticket.committed).rejects.toThrow()
  expect(f.db.prepare('SELECT count(*) AS n FROM acp_records').get()).toEqual({
    n: 0,
  })
  expect(
    f.db.prepare('SELECT provider_session_id FROM sessions').get(),
  ).toEqual({ provider_session_id: null })
  await journal.close()
})

it('stores artifact bytes atomically and rejects foreign cleanup without removing the original', async () => {
  const f = fixture()
  const owner = {
    owner: {
      ...f.owner,
      phase: 'live' as const,
      runId: 'run',
      turnId: 'turn',
      binding: {
        provider: 'custom',
        accountId: null,
        cwd: '/workspace',
        providerSessionId: 'native',
      },
    },
    itemId: 'item',
  }
  const bytes = Buffer.from('original')
  const input = {
    owner,
    purpose: 'source_metadata' as const,
    mime: 'application/json',
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
  const artifact = await f.store.contentStore.put(input, f.signal)
  await expect(
    f.store.contentStore.discard(artifact.artifactId, {
      ...owner,
      itemId: 'foreign',
    }),
  ).rejects.toThrow('owner')
  expect(f.db.prepare('SELECT bytes FROM acp_artifacts').get()).toEqual({
    bytes: new Uint8Array(bytes),
  })
  await f.store.contentStore.discard(artifact.artifactId, owner)
  await f.store.contentStore.discard(artifact.artifactId, owner)
  expect(f.db.prepare('SELECT count(*) AS n FROM acp_artifacts').get()).toEqual(
    { n: 0 },
  )
  await expect(
    f.store.contentStore.put({ ...input, sha256: '0'.repeat(64) }, f.signal),
  ).rejects.toThrow('integrity')
})

it.each(['provider', 'accountId', 'cwd'] as const)(
  'refuses foreign initial binding %s before creating a journal',
  async (field) => {
    const f = fixture()
    const binding = {
      provider: 'custom',
      accountId: null,
      cwd: '/workspace',
      providerSessionId: 'native',
    }
    await expect(
      f.store.ingestion.open(
        { ...f.input, expectedBinding: { ...binding, [field]: 'foreign' } },
        f.signal,
      ),
    ).rejects.toThrow('binding authority')
    expect(
      f.db.prepare('SELECT count(*) AS n FROM acp_journals').get(),
    ).toEqual({ n: 0 })
    const writer = await f.store.ingestion.open(f.input, f.signal)
    await writer.close()
  },
)

it.each(['itemId', 'responseId', 'childId', 'intervalId', 'mime'] as const)(
  'refuses a source reference with foreign %s',
  async (field) => {
    const f = fixture()
    const owner = {
      ...f.owner,
      phase: 'live' as const,
      runId: 'run',
      turnId: 'turn',
      binding: {
        provider: 'custom',
        accountId: null,
        cwd: '/workspace',
        providerSessionId: 'native',
      },
    }
    const subject = {
      itemId: 'item',
      responseId: 'response',
      childId: 'child',
      intervalId: 'interval',
    }
    const bytes = Buffer.from('{}')
    const reference = await f.store.contentStore.put(
      {
        owner: { owner, ...subject },
        purpose: 'source_metadata',
        mime: 'application/json',
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      f.signal,
    )
    const writer = await f.store.ingestion.open(f.input, f.signal)
    const journal = new AcpJournal(writer, {
      host: new AcpResourceHost(),
      instanceId: 'custom',
      onFailure() {},
    })
    const ticket = journal.reserve(owner, {
      producerTicket: 'source',
      kind: 'local',
    })
    ticket.finish([
      {
        subject:
          field === 'mime' ? subject : { ...subject, [field]: 'foreign' },
        value: { kind: 'disposition', status: 'ignored' },
        sourceRefs: [
          { ...reference, ...(field === 'mime' ? { mime: 'text/plain' } : {}) },
        ],
      },
    ])
    await expect(ticket.committed).rejects.toThrow()
    expect(f.db.prepare('SELECT count(*) AS n FROM acp_records').get()).toEqual(
      { n: 0 },
    )
    expect(
      f.db.prepare('SELECT count(*) AS n FROM acp_artifacts').get(),
    ).toEqual({ n: 1 })
    await journal.close()
  },
)

it.each(['item', 'usage', 'response'] as const)(
  'accepts the explicit matching %s source subject',
  async (kind) => {
    const f = fixture()
    const owner = {
      ...f.owner,
      phase: 'live' as const,
      runId: 'run',
      turnId: 'turn',
      binding: {
        provider: 'custom',
        accountId: null,
        cwd: '/workspace',
        providerSessionId: 'native',
      },
    }
    const itemId = kind === 'response' ? 'response' : 'item'
    const subject = {
      responseId: 'response',
      childId: 'child',
      intervalId: 'interval',
    }
    const bytes = Buffer.from('{}')
    const sourceRef = await f.store.contentStore.put(
      {
        owner: { owner, ...subject, itemId },
        purpose: 'source_metadata',
        mime: 'application/json',
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      f.signal,
    )
    const writer = await f.store.ingestion.open(f.input, f.signal)
    const journal = new AcpJournal(writer, {
      host: new AcpResourceHost(),
      instanceId: 'custom',
      onFailure() {},
    })
    const ticket = journal.reserve(owner, {
      producerTicket: 'source',
      kind: 'local',
    })
    const explicit =
      kind === 'item'
        ? { kind, itemId, responseId: 'response' }
        : kind === 'usage'
          ? { kind, measurementId: itemId, responseId: 'response' }
          : { kind, responseId: 'response' }
    ticket.finish([
      {
        subject,
        value: {
          kind: 'event',
          event: {
            type: 'source_reference',
            runId: 'run',
            turnId: 'turn',
            runtimeGeneration: 'runtime',
            deliveryId: 'delivery',
            childId: 'child',
            subject: explicit,
            sourceRef,
          },
        },
        sourceRefs: [sourceRef],
      },
    ])
    await ticket.committed
    expect(f.db.prepare('SELECT count(*) AS n FROM acp_records').get()).toEqual(
      { n: 1 },
    )
    await journal.close()
  },
)
