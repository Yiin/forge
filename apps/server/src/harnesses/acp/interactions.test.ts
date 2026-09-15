import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { deferred } from '../transport-test-helpers.js'
import { JsonlRpcTransport } from '../jsonrpc.js'
import type { HarnessEvent } from '../types.js'
import {
  AcpJournal,
  committedPrefix,
  emptyPrefix,
  type AcpLiveOwner,
  type PrefixTransaction,
} from './ingestion.js'
import { AcpResourceHost } from './limits.js'
import { AcpInteractions, type AcpInteractionBroker } from './interactions.js'
const owner: AcpLiveOwner = {
  sessionId: 'session',
  providerInstanceId: 'provider',
  account: { kind: 'native-default', configurationId: 'config' },
  runtimeGeneration: 'generation',
  phase: 'live',
  runId: 'run',
  turnId: 'turn',
  binding: {
    provider: 'provider',
    accountId: null,
    cwd: '/workspace',
    providerSessionId: 'native',
  },
}
const permission = {
  sessionId: 'native',
  toolCall: { toolCallId: 'tool', title: 'Run command' },
  options: [
    {
      optionId: 'allow-session',
      name: 'Allow for session',
      kind: 'allow_always',
    },
    { optionId: 'allow-permanent', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'reject', name: 'Reject once', kind: 'reject_once' },
  ],
}
function fixture(
  holdCommit = false,
  holdWrite = false,
  onAdmit?: (
    requestId: string,
    interactions: AcpInteractions,
    rpc: JsonlRpcTransport,
  ) => void,
) {
  const host = new AcpResourceHost(),
    publication = deferred<void>(),
    admitted = deferred<Parameters<AcpInteractionBroker['admit']>[0]>(),
    written = deferred<void>()
  const frames: Array<{ id: unknown; result: unknown }> = [],
    events: HarnessEvent[] = [],
    failures: unknown[] = [],
    transactions: PrefixTransaction[] = []
  let writeDone: (() => void) | undefined
  const journal = new AcpJournal(
    {
      journalId: 'journal',
      writerEpoch: 'epoch',
      committedThrough: 0,
      prefixHash: emptyPrefix('journal'),
      async commit(transaction) {
        transactions.push(transaction)
        if (holdCommit && transactions.length === 1) await publication.promise
        return {
          transactionId: transaction.transactionId,
          throughOrdinal: transaction.throughOrdinal,
          prefixHash: committedPrefix(transaction),
        }
      },
      async close() {},
    },
    {
      host,
      instanceId: 'provider',
      onFailure: () => {
        failures.push('journal')
      },
    },
  )
  const stdin = new Writable({
      write(bytes, _encoding, callback) {
        frames.push(JSON.parse(bytes.toString()))
        written.resolve()
        if (holdWrite) writeDone = callback
        else callback()
      },
    }),
    stdout = new PassThrough()
  const handlers: Promise<void>[] = []
  const rpc: JsonlRpcTransport = new JsonlRpcTransport({
    stdin,
    stdout,
    runtimeGeneration: 'private-transport',
    resources: host.transport('provider'),
    onIncoming(message): void | Promise<void> {
      if (message.type !== 'request') return
      const ticket = journal.reserve(owner, {
        kind: 'request',
        producerTicket: String(message.id),
      })
      const promise = interactions.receive(message, owner, ticket)
      handlers.push(promise)
      return promise
    },
  })
  const retired = vi.fn()
  const interactions: AcpInteractions = new AcpInteractions({
    transportGeneration: 'private-transport',
    profile: 'grok',
    rpc,
    journal,
    host,
    instanceId: 'provider',
    broker: {
      admit(value) {
        admitted.resolve(value)
        onAdmit?.(value.request.requestId, interactions, rpc)
        return { retire: retired }
      },
    },
    event: (captured, body) => ({
      ...body,
      runId: captured.runId,
      turnId: captured.turnId,
      runtimeGeneration: captured.runtimeGeneration,
      deliveryId: 'delivery',
      itemId: body.request.requestId,
    }),
    emit: (event) => events.push(event),
    fail: (error) => failures.push(error),
  })
  return {
    journal,
    interactions,
    frames,
    events,
    failures,
    transactions,
    admitted: admitted.promise,
    written: written.promise,
    retired,
    block() {
      return rpc.notify('_fixture/block')
    },
    send(
      method = 'session/request_permission',
      params: unknown = permission,
      id: string | number = 0,
    ) {
      stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
      )
    },
    releasePublication() {
      publication.resolve()
    },
    releaseWrite() {
      writeDone?.()
      writeDone = undefined
    },
    async close() {
      publication.resolve()
      writeDone?.()
      await interactions.retireOwner(owner)
      rpc.close()
      await Promise.allSettled(handlers)
      await journal.close()
      stdin.destroy()
      stdout.destroy()
    },
  }
}
describe('ACP original interaction callbacks', () => {
  it('writes the exact selected native ID before earlier history persists and rejects duplicate replies', async () => {
    const f = fixture(true)
    try {
      const earlier = f.journal.reserve(owner, {
        kind: 'native',
        producerTicket: 'earlier',
      })
      earlier.finish([{ value: { kind: 'disposition', status: 'ignored' } }])
      f.send()
      const input = await f.admitted,
        requestId = input.request.requestId
      await expect(
        f.interactions.replyPermission({
          type: 'selected',
          requestId,
          optionId: 'unknown',
        }),
      ).rejects.toThrow('offered')
      const response = f.interactions.replyPermission({
        type: 'selected',
        requestId,
        optionId: 'allow-permanent',
      })
      await f.written
      expect(f.frames).toEqual([
        {
          jsonrpc: '2.0',
          id: 0,
          result: {
            outcome: { outcome: 'selected', optionId: 'allow-permanent' },
          },
        },
      ])
      let settled = false
      void response.then(() => {
        settled = true
      })
      await expect(
        f.interactions.replyPermission({ type: 'denied', requestId }),
      ).rejects.toThrow('answerable')
      expect(settled).toBe(false)
      expect(f.events).toEqual([])
      f.releasePublication()
      await response
      expect(f.retired).toHaveBeenCalledTimes(1)
      expect(f.failures).toEqual([])
    } finally {
      await f.close()
    }
  })
  it('maps explicit denial to cancelled without selecting an allow option', async () => {
    const f = fixture()
    try {
      f.send(undefined, undefined, 'original')
      const input = await f.admitted
      await f.interactions.replyPermission({
        type: 'denied',
        requestId: input.request.requestId,
      })
      expect(f.frames[0]).toMatchObject({
        id: 'original',
        result: { outcome: { outcome: 'cancelled' } },
      })
    } finally {
      await f.close()
    }
  })
  it('sends Grok question labels through the same original RPC request', async () => {
    const f = fixture()
    try {
      f.send(
        '_x.ai/ask_user_question',
        {
          sessionId: 'native',
          toolCallId: 'question-tool',
          mode: 'default',
          questions: [
            {
              question: 'Choose?',
              options: [{ id: 'yes', label: 'Yes', preview: 'Native preview' }],
            },
          ],
        },
        'question-native',
      )
      const input = await f.admitted
      await f.interactions.replyQuestion(input.request.requestId, {
        'question-0': { type: 'selected', optionIds: ['yes'] },
      })
      expect(f.frames).toEqual([
        {
          jsonrpc: '2.0',
          id: 'question-native',
          result: {
            outcome: 'accepted',
            answers: { 'Choose?': ['Yes'] },
            annotations: { 'Choose?': { preview: 'Native preview' } },
          },
        },
      ])
    } finally {
      await f.close()
    }
  })
  it('leaves structured grant rejection answerable on the original request', async () => {
    const f = fixture()
    try {
      f.send()
      const input = await f.admitted,
        requestId = input.request.requestId
      await expect(
        f.interactions.replyPermission({
          type: 'selected',
          requestId,
          optionId: 'allow-session',
          scope: 'session',
        }),
      ).rejects.toThrow('unsupported')
      expect(f.frames).toEqual([])
      await f.interactions.replyPermission({
        type: 'selected',
        requestId,
        optionId: 'allow-session',
      })
      expect(f.frames).toHaveLength(1)
    } finally {
      await f.close()
    }
  })
  it('keeps a reentrant held reply owned when broker admission throws', async () => {
    let response: Promise<void> | undefined
    const f = fixture(false, true, (requestId, interactions) => {
      response = interactions.replyPermission({
        type: 'selected',
        requestId,
        optionId: 'reject',
      })
      void response.catch(() => {})
      throw Error('broker failed')
    })
    try {
      f.send()
      await f.written
      let settled = false
      void response!.catch(() => {
        settled = true
      })
      expect(settled).toBe(false)
      f.releaseWrite()
      await expect(response).rejects.toThrow('indeterminate')
      expect(f.frames).toHaveLength(1)
    } finally {
      await f.close()
    }
  })
  it('observes synchronous transport closure during broker admission', async () => {
    const f = fixture(false, false, (_requestId, _interactions, rpc) =>
      rpc.close(),
    )
    try {
      f.send()
      await f.admitted
      await f.interactions.retireOwner(owner)
      expect(f.frames).toEqual([])
      expect(f.retired).toHaveBeenCalledTimes(1)
    } finally {
      await f.close()
    }
  })
  it('records withdrawal before write when cancellation removes a queued reply', async () => {
    const f = fixture(false, true)
    try {
      const blocker = f.block()
      f.send()
      const input = await f.admitted
      const reply = f.interactions.replyPermission({
        type: 'selected',
        requestId: input.request.requestId,
        optionId: 'reject',
      })
      const rejection = expect(reply).rejects.toThrow('withdrawn before write')
      await f.interactions.retireOwner(owner)
      await rejection
      expect(f.frames).toHaveLength(1)
      expect(f.frames[0]).not.toHaveProperty('id')
      expect(
        f.transactions
          .flatMap((transaction) => transaction.records)
          .filter((record) => record.value.kind === 'interaction')
          .map(
            (record) =>
              record.value.kind === 'interaction' && record.value.status,
          ),
      ).toEqual(['pending', 'retired'])
      f.releaseWrite()
      await blocker
    } finally {
      await f.close()
    }
  })
  it('finishes ownership when external broker retirement throws', async () => {
    const f = fixture()
    try {
      f.retired.mockImplementation(() => {
        throw Error('broker retire failed')
      })
      f.send()
      const input = await f.admitted
      await f.interactions.replyPermission({
        type: 'denied',
        requestId: input.request.requestId,
      })
      await f.interactions.retireOwner(owner)
      expect(f.retired).toHaveBeenCalledTimes(1)
      expect(f.failures).toHaveLength(1)
    } finally {
      await f.close()
    }
  })
  it('retains a handed-off response through owner cancellation until the original callback settles', async () => {
    const f = fixture(false, true)
    try {
      f.send()
      const input = await f.admitted
      const reply = f.interactions.replyPermission({
        type: 'selected',
        requestId: input.request.requestId,
        optionId: 'reject',
      })
      const rejection = expect(reply).rejects.toThrow('indeterminate')
      await f.written
      const retired = f.interactions.retireOwner(owner)
      const repeated = f.interactions.retireOwner(owner)
      let repeatedClosed = false
      void repeated.then(() => {
        repeatedClosed = true
      })
      let closed = false
      void retired.then(() => {
        closed = true
      })
      expect(closed).toBe(false)
      expect(repeatedClosed).toBe(false)
      f.releaseWrite()
      await Promise.all([rejection, retired, repeated])
      expect(f.frames).toHaveLength(1)
      expect(
        f.transactions
          .flatMap((transaction) => transaction.records)
          .some(
            (record) =>
              record.value.kind === 'interaction' &&
              record.value.status === 'indeterminate',
          ),
      ).toBe(true)
    } finally {
      await f.close()
    }
  })
})
