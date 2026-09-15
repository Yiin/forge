import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpResourceHost } from './limits.js'
import { deferred } from '../transport-test-helpers.js'
import {
  AcpJournal,
  AcpUnknownAcknowledgement,
  committedPrefix,
  emptyPrefix,
  type AcpLiveOwner,
  type AcpSessionWriter,
  type CommittedPrefix,
  type PrefixTransaction,
} from './ingestion.js'

const owner = (runId = 'root'): AcpLiveOwner => ({
  sessionId: 'session',
  providerInstanceId: 'provider',
  account: { kind: 'native-default', configurationId: 'config' },
  runtimeGeneration: 'generation',
  phase: 'live',
  runId,
  turnId: runId,
  binding: {
    provider: 'provider',
    accountId: null,
    cwd: '/workspace',
    providerSessionId: 'native',
  },
})
const options = (onFailure = () => {}, commitMs?: number) => ({
  host: new AcpResourceHost(),
  instanceId: 'provider',
  onFailure,
  commitMs,
})
const source = { kind: 'native' as const, producerTicket: 'original' }
const records = [
  { value: { kind: 'disposition' as const, status: 'ignored' as const } },
]
const ack = (transaction: PrefixTransaction): CommittedPrefix => ({
  transactionId: transaction.transactionId,
  throughOrdinal: transaction.throughOrdinal,
  prefixHash: committedPrefix(transaction),
})
function writer(commit: AcpSessionWriter['commit']): AcpSessionWriter {
  return {
    journalId: 'journal',
    writerEpoch: 'epoch',
    committedThrough: 0,
    prefixHash: emptyPrefix('journal'),
    commit,
    close: vi.fn(async () => {}),
  }
}
afterEach(() => vi.useRealTimers())
describe('ACP ordered durable prefix', () => {
  it('fails only an original unfinished admission and latches once', async () => {
    const onFailure = vi.fn(),
      commit = vi.fn(async (tx: PrefixTransaction) => ack(tx))
    const journal = new AcpJournal(writer(commit), options(onFailure))
    try {
      const ticket = journal.reserve(owner(), source)
      expect(() => ({ ...ticket }).failAdmission()).toThrow('Foreign')
      ticket.failAdmission()
      ticket.failAdmission()
      await expect(ticket.committed).rejects.toThrow('admission failed')
      expect(onFailure).toHaveBeenCalledTimes(1)
      expect(commit).not.toHaveBeenCalled()
      expect(() => ticket.finish(records)).toThrow('retired')
    } finally {
      await journal.close()
    }
  })
  it('cannot relabel a finished ticket while its original commit is held', async () => {
    const entered = deferred<void>(),
      release = deferred<void>(),
      onFailure = vi.fn()
    const journal = new AcpJournal(
      writer(async (tx) => {
        entered.resolve()
        await release.promise
        return ack(tx)
      }),
      options(onFailure),
    )
    try {
      const ticket = journal.reserve(owner(), source)
      ticket.finish(records)
      await entered.promise
      expect(() => ticket.failAdmission()).toThrow('already finished')
      release.resolve()
      await ticket.committed
      expect(() => ticket.failAdmission()).toThrow('already finished')
      expect(onFailure).not.toHaveBeenCalled()
    } finally {
      release.resolve()
      await journal.close()
    }
  })
  it.each(['ack', 'reject'] as const)(
    'preserves an entered terminal when a later producer fails: %s',
    async (outcome) => {
      const entered = deferred<void>(),
        gate = deferred<void>()
      const journal = new AcpJournal(
        writer(async (tx) => {
          entered.resolve()
          await gate.promise
          if (outcome === 'reject') throw Error('original writer refused')
          return ack(tx)
        }),
        options(),
      )
      const original = owner('first'),
        later = owner('later'),
        identity = { receiptId: 'receipt', completionId: 'completion' }
      try {
        const first = journal.reserve(
          original,
          { kind: 'terminal', producerTicket: 'terminal' },
          true,
        )
        first.finish(records)
        await entered.promise
        const second = journal.reserve(later, source)
        second.failAdmission()
        await expect(second.committed).rejects.toThrow('admission failed')
        expect(journal.completionFailure(original, identity)).toMatchObject({
          code: 'persistence_unknown',
          persistence: {
            classification: 'ack_unknown',
            required: { state: 'unproved', terminal: { phase: 'entered' } },
          },
        })
        gate.resolve()
        if (outcome === 'ack') {
          await first.committed
          expect(() => journal.completionFailure(original, identity)).toThrow(
            'already acknowledged',
          )
          expect(journal.completionFailure(later, identity)).toMatchObject({
            code: 'completion_not_committed',
            persistence: {
              failure: { lastAcknowledged: { throughOrdinal: 1 } },
            },
          })
        } else {
          await expect(first.committed).rejects.toThrow('unproved')
          expect(journal.completionFailure(original, identity)).toMatchObject({
            code: 'persistence_unknown',
            persistence: {
              classification: 'commit_failed',
              required: {
                terminal: { phase: 'entered', physical: 'rejected' },
              },
            },
          })
        }
      } finally {
        gate.resolve()
        await journal.close()
      }
    },
  )
  it('does not reenter the physical writer through a synchronous commit callback', async () => {
    const gate = deferred<void>(),
      calls: PrefixTransaction[] = []
    let second!: ReturnType<AcpJournal['reserve']>
    const journal = new AcpJournal(
      writer(async (tx) => {
        calls.push(tx)
        if (calls.length === 1) {
          second.finish(records)
          await gate.promise
        }
        return ack(tx)
      }),
      options(),
    )
    try {
      const first = journal.reserve(owner(), source)
      second = journal.reserve(owner('second'), source)
      first.finish(records)
      expect(calls).toHaveLength(1)
      gate.resolve()
      await Promise.all([first.committed, second.committed])
      expect(calls.map((tx) => [tx.afterOrdinal, tx.throughOrdinal])).toEqual([
        [0, 1],
        [1, 2],
      ])
    } finally {
      gate.resolve()
      await journal.close()
    }
  })
  it('coalesces bounded admission waits and wakes only after original slots commit', async () => {
    const entered = deferred<void>(),
      release = deferred<void>()
    const journal = new AcpJournal(
      writer(async (tx) => {
        entered.resolve()
        await release.promise
        return ack(tx)
      }),
      options(),
    )
    try {
      const tickets = Array.from({ length: 62 }, () =>
        journal.reserve(owner(), source),
      )
      const waiting = journal.admissionReady()!
      expect(waiting).toBe(journal.admissionReady())
      expect(journal.admissionReady(true)).toBeUndefined()
      let ready = false
      void waiting.then(() => {
        ready = true
      })
      tickets[0]!.finish(records)
      await entered.promise
      expect(ready).toBe(false)
      release.resolve()
      await waiting
      expect(journal.admissionReady()).toBeUndefined()
      journal.reserve(owner(), source)
      const closeWait = journal.admissionReady()!
      await journal.close()
      await expect(closeWait).rejects.toThrow('unavailable')
    } finally {
      release.resolve()
      await journal.close()
    }
  })
  it('wakes credit waiters and rejects admission waits on producer failure', async () => {
    const journal = new AcpJournal(
      writer(async (tx) => ack(tx)),
      options(),
    )
    try {
      const credit = journal.reserveCredits(62)
      const first = journal.admissionReady()!
      credit.consume()
      await first
      const ticket = journal.reserve(owner(), source)
      const next = journal.admissionReady()!
      ticket.failAdmission()
      await expect(next).rejects.toThrow('unavailable')
      credit.release()
    } finally {
      await journal.close()
    }
  })
  it('waits for earlier slots and captures immutable original ownership', async () => {
    const calls: PrefixTransaction[] = []
    const sink = writer(async (transaction) => {
      calls.push(transaction)
      return ack(transaction)
    })
    const journal = new AcpJournal(sink, options())
    try {
      const original = owner(),
        first = journal.reserve(original, source),
        second = journal.reserve(owner('later'), source)
      Object.assign(original, { runId: 'changed' })
      Object.assign(sink, { journalId: 'changed', writerEpoch: 'changed' })
      second.finish(records)
      expect(calls).toHaveLength(0)
      first.finish(records)
      await Promise.all([first.committed, second.committed])
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        journalId: 'journal',
        writerEpoch: 'epoch',
        afterOrdinal: 0,
        throughOrdinal: 2,
      })
      expect(
        calls[0]!.records.map(
          (record) => record.owner.phase === 'live' && record.owner.runId,
        ),
      ).toEqual(['root', 'later'])
      expect(Object.isFrozen(calls[0]!.records[0]!.owner)).toBe(true)
    } finally {
      await journal.close()
    }
  })
  it('retries exactly once only after an explicitly unknown call settles', async () => {
    const held = deferred<CommittedPrefix>(),
      entered = deferred<void>(),
      calls: PrefixTransaction[] = []
    const journal = new AcpJournal(
      writer(async (transaction) => {
        calls.push(transaction)
        if (calls.length === 1) {
          entered.resolve()
          return held.promise
        }
        return ack(transaction)
      }),
      options(),
    )
    try {
      const ticket = journal.reserve(owner(), source)
      ticket.finish(records)
      await entered.promise
      expect(calls).toHaveLength(1)
      held.reject(new AcpUnknownAcknowledgement('Unknown acknowledgement'))
      await ticket.committed
      expect(calls).toHaveLength(2)
      expect(calls[1]).toBe(calls[0])
    } finally {
      await journal.close()
    }
  })
  it('keeps the physical writer until actual settlement after its logical deadline', async () => {
    vi.useFakeTimers()
    const held = deferred<CommittedPrefix>(),
      transactions: PrefixTransaction[] = [],
      failed = vi.fn()
    const sink = writer(async (transaction) => {
      transactions.push(transaction)
      return held.promise
    })
    const journal = new AcpJournal(sink, options(failed, 15))
    const ticket = journal.reserve(owner(), source)
    ticket.finish(records)
    await vi.advanceTimersByTimeAsync(15)
    await expect(ticket.committed).rejects.toThrow('unproved')
    expect(failed).toHaveBeenCalledTimes(1)
    const closing = journal.close()
    expect(sink.close).not.toHaveBeenCalled()
    expect(transactions).toHaveLength(1)
    held.resolve(ack(transactions[0]!))
    await closing
    expect(sink.close).toHaveBeenCalledTimes(1)
  })
  it('does not retry invalid acknowledgements or blame a later root for the failed prefix', async () => {
    const commit = vi.fn(async (transaction: PrefixTransaction) => ({
      ...ack(transaction),
      throughOrdinal: 99,
    }))
    const journal = new AcpJournal(writer(commit), options())
    try {
      const ticket = journal.reserve(owner(), source)
      journal.reserve(owner('later'), source)
      ticket.finish(records)
      await expect(ticket.committed).rejects.toThrow('unproved')
      expect(commit).toHaveBeenCalledTimes(1)
      const error = journal.completionFailure(owner('later'), {
        receiptId: 'receipt',
        completionId: 'completion',
      })
      expect(error.persistence).toMatchObject({
        cause: { relation: 'session_fence', owner: { runId: 'root' } },
        required: {
          state: 'unproved',
          terminal: { phase: 'pre_admission' },
        },
      })
      expect(() => journal.reserve(owner(), source)).toThrow('unavailable')
    } finally {
      await journal.close()
    }
  })
  it('holds shared commit capacity across replacement journals until the original callback settles', async () => {
    vi.useFakeTimers()
    const host = new AcpResourceHost({ commits: [1, 1] })
    const held = deferred<CommittedPrefix>()
    let transaction!: PrefixTransaction
    const old = new AcpJournal(
      writer(async (value) => {
        transaction = value
        return held.promise
      }),
      { ...options(), host, commitMs: 10 },
    )
    const ticket = old.reserve(owner(), source)
    ticket.finish(records)
    await vi.advanceTimersByTimeAsync(10)
    await expect(ticket.committed).rejects.toThrow('unproved')
    expect(() => host.reserve('provider', 'commits')).toThrow('limit')
    const closing = old.close()
    expect(() => host.reserve('provider', 'commits')).toThrow('limit')
    held.resolve(ack(transaction))
    await closing
    host.reserve('provider', 'commits')()
  })
  it('latches oversized combined record structure once without invoking the writer', async () => {
    const commit = vi.fn(async (transaction: PrefixTransaction) =>
        ack(transaction),
      ),
      failed = vi.fn()
    const journal = new AcpJournal(writer(commit), options(failed))
    try {
      const first = journal.reserve(owner(), source),
        second = journal.reserve(owner(), source)
      const large = [
        {
          value: {
            kind: 'event' as const,
            event: {
              type: 'tool_started' as const,
              runtimeGeneration: 'generation',
              deliveryId: 'delivery',
              runId: 'root',
              turnId: 'root',
              itemId: 'tool',
              toolCallId: 'tool',
              name: 'tool',
              input: Array(40000).fill(false),
            },
          },
        },
      ]
      second.finish(large)
      first.finish(large)
      await expect(first.committed).rejects.toThrow('admission')
      await expect(second.committed).rejects.toThrow('admission')
      expect(commit).not.toHaveBeenCalled()
      expect(failed).toHaveBeenCalledTimes(1)
      expect(() => journal.retireOwner(owner())).toThrow('unsettled')
    } finally {
      await journal.close()
    }
  })
  it('reports capacity refusal before commit entry and rejects foreign completion authority', async () => {
    const host = new AcpResourceHost({ commits: [1, 1] }),
      release = host.reserve('provider', 'commits')
    const commit = vi.fn(async (transaction: PrefixTransaction) =>
      ack(transaction),
    )
    const journal = new AcpJournal(writer(commit), { ...options(), host })
    try {
      const ticket = journal.reserve(owner(), source)
      ticket.finish(records)
      await expect(ticket.committed).rejects.toThrow('admission')
      expect(commit).not.toHaveBeenCalled()
      const identity = { receiptId: 'receipt', completionId: 'completion' }
      expect(
        journal.completionFailure(owner(), identity).persistence,
      ).toMatchObject({
        code: 'completion_not_committed',
        failure: { phase: 'pre_admission' },
        required: { state: 'not_committed' },
      })
      for (const change of [
        { providerInstanceId: 'foreign' },
        { runtimeGeneration: 'foreign' },
        {
          account: {
            kind: 'native-default' as const,
            configurationId: 'foreign',
          },
        },
        { binding: { ...owner().binding, providerSessionId: 'foreign' } },
        { runId: 'unadmitted' },
      ])
        expect(() =>
          journal.completionFailure({ ...owner(), ...change }, identity),
        ).toThrow('Foreign')
    } finally {
      release()
      await journal.close()
    }
  })
  it('retains retirement proof across late observations and completed replay segments', async () => {
    const host = new AcpResourceHost(),
      gate = deferred<void>(),
      entered = deferred<void>()
    let held = false
    const journal = new AcpJournal(
      writer(async (tx) => {
        if (held) {
          entered.resolve()
          await gate.promise
        }
        return ack(tx)
      }),
      { ...options(), host },
    )
    try {
      const original = owner()
      await journal.append(
        original,
        { kind: 'disposition', status: 'ignored' },
        'terminal',
      )
      journal.retireOwner(original)
      held = true
      const late = journal.reserve(original, source)
      late.finish(records)
      await entered.promise
      expect(journal.canRetireOwner(original)).toBe(false)
      gate.resolve()
      await late.committed
      expect(journal.canRetireOwner(original)).toBe(true)
      journal.retireOwner(original)
      held = false
      const { runId: _run, turnId: _turn, ...base } = original
      for (let index = 0; index < 129; index++) {
        const replay = {
          ...base,
          phase: 'load_replay' as const,
          loadId: String(index),
          requestedNativeSessionId: 'native',
        }
        const ticket = journal.reserve(replay, source)
        expect(journal.canRetireOwner(replay)).toBe(false)
        ticket.finish([
          { value: { kind: 'disposition', status: 'replay_visible' } },
        ])
        await ticket.committed
        expect(journal.canRetireOwner(replay)).toBe(true)
        journal.retireOwner(replay)
      }
    } finally {
      gate.resolve()
      await journal.close()
    }
    host.reserve('provider', 'retained', 128 * 1024 * 1024)()
  })
  it('retires acknowledged terminal owners across more than 256 turns without retiring pending owners', async () => {
    const journal = new AcpJournal(
      writer(async (transaction) => ack(transaction)),
      options(),
    )
    try {
      for (let index = 0; index < 257; index++) {
        const current = owner(String(index))
        await journal.append(
          current,
          { kind: 'disposition', status: 'ignored' },
          'terminal',
        )
        journal.retireOwner(current)
      }
      const pending = owner('pending')
      journal.reserve(pending, source)
      expect(() => journal.retireOwner(pending)).toThrow('unsettled')
    } finally {
      await journal.close()
    }
  })
  it('protects promised credits and refuses silent empty slots', async () => {
    const journal = new AcpJournal(
      writer(async (transaction) => ack(transaction)),
      options(),
    )
    try {
      const credits = journal.reserveCredits(3)
      for (let index = 0; index < 59; index++) journal.reserve(owner(), source)
      expect(() => journal.reserve(owner(), source)).toThrow('limit')
      credits.consume()
      const reserved = journal.reserve(owner(), source)
      expect(() => reserved.finish([])).toThrow('record limit')
      journal.reserve(owner(), source, true)
      journal.reserve(owner(), source, true)
      expect(() => journal.reserve(owner(), source, true)).toThrow('limit')
      credits.release()
    } finally {
      await journal.close()
    }
  })
})
