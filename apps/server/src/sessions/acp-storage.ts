import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { HarnessSession } from '../harnesses/types.js'
import {
  committedPrefix,
  emptyPrefix,
  type AcpContentStore,
  type AcpIngestionFactory,
  type AcpRecordOwner,
  type DurableAcpRecord,
  type CommittedPrefix,
  type PrefixTransaction,
} from '../harnesses/acp/ingestion.js'
import { digest, immutableData } from '../harnesses/acp/data.js'
import { NativeStorage, sameNativeValue } from './native-storage.js'
import { projectAcpReplay } from './acp-replay.js'
import { publishAppendedMessage } from '../db/queries.js'
import type { EventBus } from '../events/bus.js'

type JournalRow = {
  provider: string
  account: string
  journal_id: string
  writer_epoch: string
  committed_through: number
  prefix_hash: string
  binding: string | null
}
const writers = new WeakMap<DatabaseSync, Set<string>>()

/** The journal acknowledgement follows the original SQLite transaction. */
export function createAcpStorage(
  db: DatabaseSync,
  input: HarnessSession,
  bus?: EventBus,
) {
  const session = immutableData(input)
  const authority = new NativeStorage(db, session)
  const row = () =>
    db
      .prepare('SELECT * FROM acp_journals WHERE session_id=?')
      .get(session.id) as JournalRow | undefined
  const assertOwner = (owner: AcpRecordOwner) => {
    authority.assertSession()
    if (
      owner.sessionId !== session.id ||
      owner.providerInstanceId !== session.provider ||
      (owner.account.kind === 'selected-account'
        ? owner.account.accountId
        : null) !== session.accountId
    )
      throw Error('ACP storage owner changed')
    const binding =
      owner.phase === 'control' ? owner.expectedBinding : owner.binding
    if (
      binding &&
      (binding.provider !== session.provider ||
        binding.accountId !== session.accountId ||
        binding.cwd !== session.cwd)
    )
      throw Error('ACP storage binding authority changed')
    const saved = row()
    if (saved && !sameNativeValue(JSON.parse(saved.account), owner.account))
      throw Error('ACP storage account configuration changed')
    if (
      binding &&
      saved?.binding &&
      !sameNativeValue(binding, JSON.parse(saved.binding))
    )
      throw Error('ACP storage native binding changed')
  }
  const ingestion: AcpIngestionFactory = {
    async open(value, signal) {
      const opening = immutableData(value)
      signal.throwIfAborted()
      authority.assertSession()
      if (
        opening.sessionId !== session.id ||
        opening.providerInstanceId !== session.provider ||
        (opening.account.kind === 'selected-account'
          ? opening.account.accountId
          : null) !== session.accountId
      )
        throw Error('ACP writer authority changed')
      const binding = opening.expectedBinding
      if (
        binding &&
        (binding.provider !== session.provider ||
          binding.accountId !== session.accountId ||
          binding.cwd !== session.cwd)
      )
        throw Error('ACP writer binding authority changed')
      let active = writers.get(db)
      if (!active) writers.set(db, (active = new Set()))
      if (active.has(session.id))
        throw Error('ACP session already has a writer')
      const epoch = randomUUID()
      const journal = authority.transaction(signal, () => {
        let current = row()
        if (current) {
          if (
            current.provider !== session.provider ||
            !sameNativeValue(JSON.parse(current.account), opening.account) ||
            (current.binding &&
              !sameNativeValue(
                JSON.parse(current.binding),
                opening.expectedBinding,
              ))
          )
            throw Error('ACP journal resume authority changed')
          db.prepare(
            'UPDATE acp_journals SET writer_epoch=? WHERE session_id=?',
          ).run(epoch, session.id)
        } else {
          const id = randomUUID()
          db.prepare('INSERT INTO acp_journals VALUES (?,?,?,?,?,?,?,?)').run(
            session.id,
            session.provider,
            JSON.stringify(opening.account),
            id,
            epoch,
            0,
            emptyPrefix(id),
            opening.expectedBinding
              ? JSON.stringify(opening.expectedBinding)
              : null,
          )
          current = row()!
        }
        return current
      })
      active.add(session.id)
      let closed = false
      return {
        journalId: journal.journal_id,
        writerEpoch: epoch,
        committedThrough: journal.committed_through,
        prefixHash: journal.prefix_hash,
        async commit(value, signal) {
          const tx = immutableData(value, 4 * 1024 * 1024)
          signal.throwIfAborted()
          if (closed) throw Error('ACP writer is closed')
          const published: ReturnType<typeof projectAcpReplay> = []
          const result = authority.transaction(signal, () => {
            const current = row()!
            if (
              current.writer_epoch !== epoch ||
              tx.writerEpoch !== epoch ||
              tx.journalId !== current.journal_id
            )
              throw Error('ACP writer epoch changed')
            const retry = db
              .prepare(
                'SELECT value,acknowledgement FROM acp_transactions WHERE transaction_id=?',
              )
              .get(tx.transactionId) as
              { value: string; acknowledgement: string } | undefined
            if (retry) {
              if (!sameNativeValue(JSON.parse(retry.value), tx))
                throw Error('ACP transaction retry changed')
              return JSON.parse(retry.acknowledgement) as CommittedPrefix
            }
            validateTransaction(tx, current)
            for (const record of tx.records) {
              assertOwner(record.owner)
              for (const reference of record.sourceRefs) {
                const artifact = db
                  .prepare(
                    'SELECT owner,mime,sha256,length(bytes) AS size FROM acp_artifacts WHERE artifact_id=? AND session_id=?',
                  )
                  .get(reference.artifactId, session.id) as
                  | {
                      owner: string
                      mime: string
                      sha256: string
                      size: number
                    }
                  | undefined
                if (
                  !artifact ||
                  !sameNativeValue(
                    JSON.parse(artifact.owner),
                    sourceOwner(record),
                  ) ||
                  artifact.mime !== reference.mime ||
                  artifact.sha256 !== reference.sha256 ||
                  artifact.size !== reference.bytes
                )
                  throw Error('ACP source reference authority changed')
              }
              if (record.value.kind === 'binding') {
                const binding = record.value.binding
                if (
                  binding.provider !== session.provider ||
                  binding.accountId !== session.accountId ||
                  binding.cwd !== session.cwd ||
                  (current.binding &&
                    !sameNativeValue(JSON.parse(current.binding), binding))
                )
                  throw Error('ACP confirmed binding changed')
                current.binding = JSON.stringify(binding)
                db.prepare(
                  'UPDATE acp_journals SET binding=? WHERE session_id=?',
                ).run(current.binding, session.id)
                db.prepare(
                  'UPDATE sessions SET provider_session_id=? WHERE id=?',
                ).run(binding.providerSessionId, session.id)
              }
              db.prepare('INSERT INTO acp_records VALUES (?,?,?,?,?)').run(
                record.recordId,
                session.id,
                record.admissionOrdinal,
                record.recordIndex,
                JSON.stringify(record),
              )
            }
            for (const record of tx.records)
              if (
                record.owner.phase === 'load_replay' &&
                record.value.kind === 'disposition' &&
                record.value.status === 'replay_visible'
              )
                published.push(...projectAcpReplay(db, record.owner))
            const acknowledgement = {
              transactionId: tx.transactionId,
              throughOrdinal: tx.throughOrdinal,
              prefixHash: committedPrefix(tx),
            }
            db.prepare('INSERT INTO acp_transactions VALUES (?,?,?,?,?)').run(
              tx.transactionId,
              session.id,
              tx.throughOrdinal,
              JSON.stringify(tx),
              JSON.stringify(acknowledgement),
            )
            db.prepare(
              'UPDATE acp_journals SET committed_through=?,prefix_hash=? WHERE session_id=?',
            ).run(tx.throughOrdinal, acknowledgement.prefixHash, session.id)
            return acknowledgement
          })
          for (const saved of published) {
            try {
              publishAppendedMessage(bus, saved)
            } catch {
              console.warn(
                'ACP replay notification failed after durable commit',
              )
            }
          }
          return result
        },
        async close() {
          if (closed) return
          closed = true
          active.delete(session.id)
        },
      }
    },
  }
  const contentStore: AcpContentStore = {
    async put(input, signal) {
      signal.throwIfAborted()
      const owner = immutableData(input.owner)
      assertOwner(owner.owner)
      if (
        !['content', 'source_metadata', 'replay'].includes(input.purpose) ||
        !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[\x20-\x7e]*)?$/i.test(
          input.mime,
        ) ||
        input.mime.length > 256 ||
        input.bytes.byteLength > 10 * 1024 * 1024 ||
        createHash('sha256').update(input.bytes).digest('hex') !== input.sha256
      )
        throw Error('ACP artifact integrity mismatch')
      const id = randomUUID()
      authority.transaction(signal, () => {
        db.prepare('INSERT INTO acp_artifacts VALUES (?,?,?,?,?,?,?)').run(
          id,
          session.id,
          JSON.stringify(owner),
          input.purpose,
          input.mime,
          input.sha256,
          input.bytes,
        )
      })
      return {
        artifactId: id,
        mime: input.mime,
        bytes: input.bytes.byteLength,
        sha256: input.sha256,
      }
    },
    async discard(artifactId, input) {
      const owner = immutableData(input)
      const artifact = db
        .prepare(
          'SELECT owner,session_id FROM acp_artifacts WHERE artifact_id=?',
        )
        .get(artifactId) as { owner: string; session_id: string } | undefined
      if (!artifact) return
      if (
        artifact.session_id !== session.id ||
        !sameNativeValue(JSON.parse(artifact.owner), owner)
      )
        throw Error('ACP artifact cleanup owner changed')
      db.prepare('DELETE FROM acp_artifacts WHERE artifact_id=?').run(
        artifactId,
      )
    },
  }
  return { ingestion, contentStore, authority }
}

function validateTransaction(tx: PrefixTransaction, current: JournalRow) {
  if (
    tx.afterOrdinal !== current.committed_through ||
    tx.previousPrefixHash !== current.prefix_hash ||
    !Number.isSafeInteger(tx.throughOrdinal) ||
    tx.throughOrdinal <= tx.afterOrdinal ||
    tx.records.length > 256 ||
    tx.contentHash !== digest(tx.records) ||
    tx.transactionId !==
      digest([
        tx.journalId,
        tx.writerEpoch,
        tx.afterOrdinal,
        tx.throughOrdinal,
        tx.previousPrefixHash,
        tx.contentHash,
      ])
  )
    throw Error('ACP transaction prefix changed')
  let ordinal = tx.afterOrdinal,
    index = 0
  for (const record of tx.records) {
    if (
      !Number.isSafeInteger(record.admissionOrdinal) ||
      record.admissionOrdinal <= tx.afterOrdinal ||
      record.admissionOrdinal > tx.throughOrdinal
    )
      throw Error('ACP transaction record range changed')
    if (record.admissionOrdinal > ordinal) {
      ordinal = record.admissionOrdinal
      index = 0
    }
    if (
      record.admissionOrdinal !== ordinal ||
      record.recordIndex !== index ||
      record.journalId !== tx.journalId ||
      record.recordId !== digest([tx.journalId, ordinal, index])
    )
      throw Error('ACP transaction record order changed')
    index++
  }
  // An admitted frame can produce zero records. The journal still commits its ordinal.
  if (ordinal > tx.throughOrdinal) throw Error('ACP transaction range changed')
}

function sourceOwner(record: DurableAcpRecord) {
  const subject = { ...record.subject }
  const event =
    record.value.kind === 'event' || record.value.kind === 'replay'
      ? record.value.event
      : undefined
  if (event?.type === 'source_reference') {
    const explicit = event.subject
    const supplied =
      explicit.kind === 'usage'
        ? { itemId: explicit.measurementId, responseId: explicit.responseId }
        : explicit.kind === 'response'
          ? { itemId: explicit.responseId, responseId: explicit.responseId }
          : explicit.kind === 'item'
            ? { itemId: explicit.itemId, responseId: explicit.responseId }
            : { childId: explicit.childId, intervalId: explicit.intervalId }
    for (const [key, value] of Object.entries(supplied)) {
      const field = key as keyof typeof subject
      if (value === undefined) continue
      if (subject[field] !== undefined && subject[field] !== value)
        throw Error('ACP source reference subject changed')
      subject[field] = value
    }
  }
  return {
    owner: record.owner,
    ...(subject.itemId === undefined ? {} : { itemId: subject.itemId }),
    ...(subject.responseId === undefined
      ? {}
      : { responseId: subject.responseId }),
    ...(subject.childId === undefined ? {} : { childId: subject.childId }),
    ...(subject.intervalId === undefined
      ? {}
      : { intervalId: subject.intervalId }),
  }
}
