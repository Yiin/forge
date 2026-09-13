import { expect, expectTypeOf, test } from 'vitest'
import {
  completionFailureProjectionSchema,
  completionFailureEnvelopeSchema,
  completionRecoveryProjectionSchema,
  completionProjectionPreflight,
} from '@forge/protocol/harness'
import {
  createCompletionHandle,
  isCompletionPersistenceFailure,
  type CompletionProducer,
  type CompletionPersistenceFailure,
} from './types.js'

const ids = { completionId: 'completion', runId: 'run', turnId: 'turn' }
function projection() {
  const evidence = {
    kind: 'batch_ordinal',
    phase: 'entered',
    lastAcknowledged: { kind: 'batch_ordinal', ordinal: 0 },
    batch: { batchId: 'a'.repeat(64), contentHash: 'b'.repeat(64) },
    input: { expectedOrdinal: 0, replayOnly: false },
    physical: 'rejected',
  }
  return {
    version: 1,
    ...ids,
    sessionId: 'session',
    receiptId: 'receipt',
    code: 'persistence_unknown',
    classification: 'commit_failed',
    cause: {
      relation: 'own_required_write',
      owner: {
        kind: 'operation',
        sessionId: 'session',
        runtimeGeneration: 'generation',
        runId: 'run',
        turnId: 'turn',
        operationId: 'operation',
      },
    },
    failure: structuredClone(evidence),
    required: { state: 'unproved', terminal: structuredClone(evidence) },
  }
}
function failure(value: unknown = projection()): CompletionPersistenceFailure {
  const parsed = completionFailureProjectionSchema.parse(value)
  const error = new Error('Private synthetic storage error')
  for (const [key, entry] of Object.entries({
    code: parsed.code,
    completionId: parsed.completionId,
    runId: parsed.runId,
    turnId: parsed.turnId,
    persistence: parsed,
  }))
    Object.defineProperty(error, key, {
      value: entry,
      enumerable: true,
      writable: false,
      configurable: false,
    })
  return error as CompletionPersistenceFailure
}

test.each(['resolve', 'reject'] as const)(
  'private identities survive metadata mutation, and first valid %s wins',
  async (first) => {
    const input = { ...ids },
      producer = createCompletionHandle(input, { persistenceRejection: true }),
      error = failure()
    input.runId = 'changed-input'
    Object.assign(producer.handle, {
      completionId: 'changed',
      runId: 'changed',
      turnId: 'changed',
    })
    const outcome = {
      status: 'completed' as const,
      runId: ids.runId,
      turnId: ids.turnId,
    }
    if (first === 'resolve') producer.settle(outcome)
    else producer.reject(error)
    producer.settle(outcome)
    producer.reject(error)
    producer.reject(error)
    if (first === 'resolve')
      await expect(producer.handle).resolves.toEqual(outcome)
    else await expect(producer.handle).rejects.toBe(error)
    for (const field of ['completionId', 'runId', 'turnId'] as const) {
      const wrong = projection()
      wrong[field] = 'other'
      if (field !== 'completionId') wrong.cause.owner[field] = 'other'
      expect(() => producer.reject(failure(wrong))).toThrow()
    }
    expect(() => producer.settle({ ...outcome, runId: 'changed' })).toThrow()
  },
)

test('the last overload preserves the exact two-property Codex reconstruction', async () => {
  expectTypeOf<
    ReturnType<typeof createCompletionHandle>
  >().toEqualTypeOf<CompletionProducer>()
  const producer = createCompletionHandle(ids),
    captured = { completion: producer.handle, settle: producer.settle }
  const reconstructed: ReturnType<typeof createCompletionHandle> = {
    handle: captured.completion,
    settle: captured.settle,
  }
  expect('reject' in reconstructed).toBe(false)
  reconstructed.settle({ status: 'interrupted', ...ids })
  await expect(reconstructed.handle).resolves.toMatchObject({
    status: 'interrupted',
  })
})

test('identity and projection accessors never run and invalid errors do not consume authority', async () => {
  let reads = 0
  const input = { ...ids }
  Object.defineProperty(input, 'runId', {
    get() {
      reads++
      return 'run'
    },
  })
  expect(() => createCompletionHandle(input)).toThrow()
  const producer = createCompletionHandle(ids, { persistenceRejection: true })
  const error = failure(),
    malicious = new Error('lookalike')
  Object.defineProperty(malicious, 'code', {
    get() {
      reads++
      return error.code
    },
  })
  expect(isCompletionPersistenceFailure(malicious)).toBe(false)
  expect(() =>
    producer.reject(malicious as CompletionPersistenceFailure),
  ).toThrow()
  const value = projection()
  Object.defineProperty(value.failure, 'physical', {
    get() {
      reads++
      return 'rejected'
    },
  })
  expect(completionFailureProjectionSchema.safeParse(value).success).toBe(false)
  expect(reads).toBe(0)
  producer.reject(error)
  await expect(producer.handle).rejects.toBe(error)
})

test('opt-in rejection is observed before receipt publication without replacing the original Promise', async () => {
  const observed: unknown[] = [],
    onUnhandled = (error: unknown) => observed.push(error)
  process.on('unhandledRejection', onUnhandled)
  try {
    const producer = createCompletionHandle(ids, {
        persistenceRejection: true,
      }),
      handle = producer.handle,
      error = failure()
    producer.reject(error)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(observed).toEqual([])
    expect(producer.handle).toBe(handle)
    await expect(handle).rejects.toBe(error)
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('all nested projection records reject unknown fields before publication', () => {
  const original = projection()
  const visit = (value: Record<string, unknown>, path: string[]) => {
    const changed = structuredClone(original) as unknown as Record<
      string,
      unknown
    >
    let target = changed
    for (const field of path) target = target[field] as Record<string, unknown>
    target.unknown = true
    expect(
      completionFailureProjectionSchema.safeParse(changed).success,
      path.join('.'),
    ).toBe(false)
    for (const [field, nested] of Object.entries(value))
      if (nested && typeof nested === 'object')
        visit(nested as Record<string, unknown>, [...path, field])
  }
  visit(original, [])
})

test.each([
  'undefined',
  'null',
  'symbol',
  'cycle',
  'prototype',
  'unsafe',
  'input',
  'mixed_family',
  'wrong_hash',
] as const)(
  'rejects malformed %s evidence in the shared parser and output envelope',
  (kind) => {
    const value = projection() as unknown as Record<string, unknown>
    const failed = value.failure as Record<string, unknown>
    if (kind === 'undefined') value.requestId = undefined
    if (kind === 'null') value.requestId = null
    if (kind === 'symbol')
      Object.defineProperty(value, Symbol('hidden'), { value: 1 })
    if (kind === 'cycle') value.requestId = value
    if (kind === 'prototype') Object.setPrototypeOf(failed, { extra: true })
    if (kind === 'unsafe')
      (failed.input as Record<string, unknown>).expectedOrdinal =
        Number.MAX_SAFE_INTEGER + 1
    if (kind === 'input')
      (failed.input as Record<string, unknown>).expectedOrdinal = 1
    if (kind === 'mixed_family') failed.kind = 'journal_prefix'
    if (kind === 'wrong_hash')
      (failed.batch as Record<string, unknown>).contentHash = 'C'.repeat(64)
    expect(completionFailureProjectionSchema.safeParse(value).success).toBe(
      false,
    )
    expect(
      completionFailureEnvelopeSchema.safeParse({ error: value }).success,
    ).toBe(false)
  },
)

test('maximum legal escaped identities fit both real bounded serializers', () => {
  const value = projection(),
    maximum = '\\"'.repeat(256)
  for (const field of [
    'sessionId',
    'receiptId',
    'completionId',
    'runId',
    'turnId',
  ] as const)
    value[field] = maximum
  for (const field of [
    'sessionId',
    'runtimeGeneration',
    'runId',
    'turnId',
    'operationId',
  ] as const)
    value.cause.owner[field] = maximum
  const parsed = completionFailureProjectionSchema.parse(value)
  expect(completionProjectionPreflight(parsed)).toBe(
    Buffer.byteLength(JSON.stringify(parsed)),
  )
  expect(Buffer.byteLength(JSON.stringify(parsed))).toBeLessThanOrEqual(16384)
  const { code: _code, classification: _classification, ...common } = parsed
  const recovery = completionRecoveryProjectionSchema.parse({
    ...common,
    state: 'unresolved',
  })
  const envelope = completionFailureEnvelopeSchema.parse({
    error: parsed,
    recovery,
  })
  expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(33792)
  expect(
    completionFailureProjectionSchema.safeParse({
      ...value,
      receiptId: maximum + 'x',
    }).success,
  ).toBe(false)
  for (const bad of ['\ud800', '\u0001', '\u0080'])
    expect(
      completionFailureProjectionSchema.safeParse({ ...value, receiptId: bad })
        .success,
    ).toBe(false)
})

test('acknowledged publication failure preserves its ordinal and rejects invented cache input', () => {
  const value = projection() as unknown as Record<string, unknown>
  const acknowledged = {
    ...(value.failure as object),
    phase: 'acknowledged',
    physical: undefined,
    acknowledgement: { via: 'sink', disposition: 'committed', ordinal: 1 },
    publication: {
      state: 'stopped',
      totalEvents: 2,
      attemptedEvents: 2,
      returnedEvents: 1,
    },
  }
  delete acknowledged.physical
  Object.assign(value, {
    code: 'completion_publication_failed',
    classification: 'publication_failed',
    failure: acknowledged,
    required: {
      state: 'committed',
      terminal: acknowledged,
      sealedThrough: { kind: 'batch_ordinal', ordinal: 1 },
    },
  })
  const parsed = completionFailureProjectionSchema.parse(value)
  expect(parsed.required.state).toBe('committed')
  const cache = {
    ...acknowledged,
    acknowledgement: { via: 'local_cache', ordinal: 1 },
    publication: {
      state: 'not_republished',
      totalEvents: 2,
      attemptedEvents: 0,
      returnedEvents: 0,
    },
  }
  expect(
    completionFailureProjectionSchema.safeParse({ ...value, failure: cache })
      .success,
  ).toBe(false)
  expect(
    isCompletionPersistenceFailure(
      Object.assign(new Error('mutable'), {
        code: 'persistence_unknown',
        ...ids,
        persistence: parsed,
      }),
    ),
  ).toBe(false)
  expect(isCompletionPersistenceFailure(failure(value))).toBe(true)
})

test.each([1, 2] as const)(
  'journal invocation %s preserves its exact prefix evidence through the neutral helper',
  async (invocation) => {
    const value = projection() as unknown as Record<string, unknown>
    const evidence = {
      kind: 'journal_prefix',
      journalId: 'journal',
      phase: 'entered',
      invocation,
      physical: 'rejected',
      lastAcknowledged: {
        kind: 'journal_prefix',
        throughOrdinal: 4,
        prefixHash: 'c'.repeat(64),
      },
      transaction: {
        transactionId: 'a'.repeat(64),
        contentHash: 'b'.repeat(64),
        fromOrdinal: 5,
        throughOrdinal: 7,
      },
    }
    Object.assign(value, {
      failure: evidence,
      required: { state: 'unproved', terminal: evidence },
    })
    const error = failure(value),
      producer = createCompletionHandle(ids, { persistenceRejection: true })
    producer.reject(error)
    await expect(producer.handle).rejects.toBe(error)
    for (const changed of [
      { ...evidence, transaction: { ...evidence.transaction, fromOrdinal: 6 } },
      {
        ...evidence,
        lastAcknowledged: { ...evidence.lastAcknowledged, prefixHash: '' },
      },
      { ...evidence, invocation: 3 },
      { ...evidence, phase: 'prepared', physical: 'pending' },
    ]) {
      expect(
        completionFailureProjectionSchema.safeParse({
          ...value,
          failure: changed,
        }).success,
      ).toBe(false)
    }
    const acknowledged = {
      kind: evidence.kind,
      journalId: evidence.journalId,
      phase: 'acknowledged',
      invocation,
      lastAcknowledged: evidence.lastAcknowledged,
      transaction: evidence.transaction,
      acknowledgement: {
        transactionId: evidence.transaction.transactionId,
        throughOrdinal: 7,
        prefixHash: 'd'.repeat(64),
      },
      publication: {
        state: 'stopped',
        totalEvents: 2,
        attemptedEvents: 1,
        returnedEvents: 0,
      },
    }
    const committed = {
      ...value,
      code: 'completion_publication_failed',
      classification: 'publication_failed',
      failure: acknowledged,
      required: {
        state: 'committed',
        terminal: acknowledged,
        sealedThrough: {
          kind: 'journal_prefix',
          throughOrdinal: 7,
          prefixHash: 'd'.repeat(64),
        },
      },
    }
    expect(isCompletionPersistenceFailure(failure(committed))).toBe(true)
    expect(
      completionFailureProjectionSchema.safeParse({
        ...committed,
        required: {
          ...committed.required,
          sealedThrough: {
            ...committed.required.sealedThrough,
            prefixHash: 'e'.repeat(64),
          },
        },
      }).success,
    ).toBe(false)
  },
)

test.each(['batch_ordinal', 'journal_prefix'] as const)(
  '%s preserves acknowledged cause and terminal when another required write did not commit',
  (kind) => {
    const publication = {
      state: 'stopped',
      totalEvents: 1,
      attemptedEvents: 1,
      returnedEvents: 0,
    }
    const acknowledged =
      kind === 'batch_ordinal'
        ? {
            kind,
            phase: 'acknowledged',
            lastAcknowledged: { kind, ordinal: 0 },
            batch: { batchId: 'a'.repeat(64), contentHash: 'b'.repeat(64) },
            input: { expectedOrdinal: 0, replayOnly: false },
            acknowledgement: {
              via: 'sink',
              disposition: 'committed',
              ordinal: 1,
            },
            publication,
          }
        : {
            kind,
            phase: 'acknowledged',
            journalId: 'journal',
            invocation: 1,
            lastAcknowledged: {
              kind,
              throughOrdinal: 0,
              prefixHash: 'a'.repeat(64),
            },
            transaction: {
              transactionId: 'b'.repeat(64),
              contentHash: 'c'.repeat(64),
              fromOrdinal: 1,
              throughOrdinal: 1,
            },
            acknowledgement: {
              transactionId: 'b'.repeat(64),
              throughOrdinal: 1,
              prefixHash: 'd'.repeat(64),
            },
            publication,
          }
    const value = {
      ...projection(),
      code: 'completion_not_committed',
      classification: 'publication_failed',
      failure: acknowledged,
      required: {
        state: 'not_committed',
        terminal: structuredClone(acknowledged),
      },
    }
    const parsed = completionFailureProjectionSchema.parse(value)
    expect(parsed.failure.phase).toBe('acknowledged')
    expect(parsed.required.terminal.phase).toBe('acknowledged')
    expect(isCompletionPersistenceFailure(failure(value))).toBe(true)
    expect(
      completionFailureProjectionSchema.safeParse({
        ...value,
        code: 'persistence_unknown',
        required: { ...value.required, state: 'unproved' },
      }).success,
    ).toBe(false)

    const {
      acknowledgement: _ack,
      publication: _publication,
      ...input
    } = acknowledged
    const pending = { ...input, phase: 'entered', physical: 'pending' }
    const unknown = {
      ...value,
      code: 'persistence_unknown',
      classification: 'ack_unknown',
      failure: pending,
      required: { ...value.required, state: 'unproved' },
    }
    expect(completionFailureProjectionSchema.safeParse(unknown).success).toBe(
      true,
    )
    expect(
      completionFailureProjectionSchema.safeParse({
        ...unknown,
        code: 'completion_not_committed',
        required: { ...value.required, state: 'not_committed' },
      }).success,
    ).toBe(false)
    const { code: _code, classification: _classification, ...common } = value
    expect(
      completionRecoveryProjectionSchema.safeParse({
        ...common,
        state: 'unresolved',
      }).success,
    ).toBe(true)
    expect(
      completionRecoveryProjectionSchema.safeParse({
        ...common,
        state: 'evidence_verified',
      }).success,
    ).toBe(false)
  },
)
