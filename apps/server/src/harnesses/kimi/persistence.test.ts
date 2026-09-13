import { expect, test, vi } from 'vitest'
import { KimiRecords, record } from './records.js'
import { KimiBudget, type KimiLimits } from './limits.js'
import { KimiHostOwner } from './host.js'
import { KimiCompletionPersistenceError } from './persistence.js'
import { isCompletionPersistenceFailure } from '../types.js'
import { createCompletionHandle } from '../types.js'
import { KimiRuntime } from './runtime.js'
import { KimiTranscript } from './transcript.js'
import type { KimiRecordSink } from './types.js'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const root = { runId: 'run-a', turnId: 'turn-a', operationId: 'operation-a' }
const scope = {
  sessionId: 'session',
  runtimeGeneration: 'generation',
  binding: {
    provider: 'kimi',
    accountId: 'synthetic',
    cwd: '/inert',
    providerSessionId: 'native',
  },
}
function fixture(
  sink: KimiRecordSink,
  limits: Partial<KimiLimits> = {},
  emit: (value: unknown) => void = () => {},
) {
  const host = new KimiHostOwner({ limits }),
    budget = new KimiBudget(host.budget.limits),
    controller = new AbortController()
  const records = new KimiRecords(
    scope,
    budget,
    host,
    sink,
    emit,
    controller.signal,
  )
  return {
    records,
    budget,
    host,
    controller,
    close: async () => {
      records.close()
      await host.close()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(host.budget.count('sinkCalls')).toBe(0)
      expect(host.budget.count('hostRetainedBytes')).toBe(0)
    },
  }
}
const entry = (key: string, owner = root) =>
  record(scope, 'local', key, 'test', { text: key }, owner)
const identity = (owner = root) => ({
  sessionId: scope.sessionId,
  completionId: owner.operationId,
  receiptId: owner.operationId,
  runId: owner.runId,
  turnId: owner.turnId,
})

test('queued distinct attempts capture CAS input inside the serial boundary and preserve initial zero', async () => {
  const gate = deferred<void>(),
    entered = deferred<void>()
  let calls = 0
  const f = fixture(async (input) => {
    if (++calls === 1) {
      entered.resolve()
      await gate.promise
    }
    return { ordinal: input.expectedOrdinal + 1, disposition: 'committed' }
  })
  const a = f.records.beginAttempt([root]),
    b = f.records.beginAttempt([root])
  try {
    const first = f.records.commit(
      'a',
      [entry('a')],
      [],
      undefined,
      false,
      Infinity,
      a,
    )
    const second = f.records.commit(
      'b',
      [entry('b')],
      [],
      undefined,
      false,
      Infinity,
      b,
    )
    await entered.promise
    expect(a.latest.phase).toBe('entered')
    expect(b.latest.phase).toBe('constructed')
    gate.resolve()
    await Promise.all([first, second])
    expect(a.initial.lastAcknowledged.ordinal).toBe(0)
    expect(b.initial.lastAcknowledged.ordinal).toBe(0)
    expect(b.latest).toMatchObject({
      phase: 'acknowledged',
      lastAcknowledged: { ordinal: 1 },
      input: { expectedOrdinal: 1, replayOnly: false },
      acknowledgement: { via: 'sink', disposition: 'committed', ordinal: 2 },
    })
  } finally {
    gate.resolve()
    await f.close()
  }
})

test('queued identical cache replay captures the serial high-water and carries no invented input', async () => {
  const gate = deferred<void>(),
    entered = deferred<void>(),
    sink = vi.fn<KimiRecordSink>(async (input) => {
      if (input.expectedOrdinal === 0) {
        entered.resolve()
        await gate.promise
      }
      return { ordinal: input.expectedOrdinal + 1, disposition: 'committed' }
    }),
    f = fixture(sink)
  const a = f.records.beginAttempt([root]),
    b = f.records.beginAttempt([root])
  try {
    const first = f.records.commit(
      'same',
      [entry('same')],
      [],
      undefined,
      false,
      Infinity,
      a,
    )
    const second = f.records.commit(
      'same',
      [entry('same')],
      [],
      undefined,
      false,
      Infinity,
      b,
    )
    await entered.promise
    gate.resolve()
    await Promise.all([first, second])
    expect(sink).toHaveBeenCalledTimes(1)
    expect(b.initial.lastAcknowledged.ordinal).toBe(0)
    expect(b.latest).toMatchObject({
      phase: 'acknowledged',
      lastAcknowledged: { ordinal: 1 },
      acknowledgement: { via: 'local_cache', ordinal: 1 },
    })
    expect('input' in b.latest).toBe(false)
    await f.records.commit('next', [entry('next')])
    const old = f.records.beginAttempt([root])
    await f.records.commit(
      'same',
      [entry('same')],
      [],
      undefined,
      false,
      Infinity,
      old,
    )
    expect(old.latest).toMatchObject({
      lastAcknowledged: { ordinal: 2 },
      acknowledgement: { via: 'local_cache', ordinal: 1 },
    })
    expect(sink).toHaveBeenCalledTimes(2)
  } finally {
    gate.resolve()
    await f.close()
  }
})

test.each(['pre_admission', 'constructed', 'prepared'] as const)(
  'a %s failure records only facts available before the sink',
  async (phase) => {
    const sink = vi.fn<KimiRecordSink>(async () => {
        throw new Error('Unexpected sink')
      }),
      f = fixture(sink),
      attempt = f.records.beginAttempt([root])
    let releaseOther = () => {}
    if (phase === 'prepared')
      releaseOther = f.host.budget.reserve(
        'sinkCalls',
        f.host.budget.limits.sinkCalls,
      )
    try {
      await expect(
        f.records.commit(
          'attempt',
          [entry('one')],
          phase === 'constructed' ? [{ type: 'invalid' } as never] : [],
          undefined,
          false,
          phase === 'pre_admission' ? -1 : Infinity,
          attempt,
        ),
      ).rejects.toBeDefined()
      expect(attempt.latest.phase).toBe(phase)
      expect('batch' in attempt.latest).toBe(phase !== 'pre_admission')
      expect('input' in attempt.latest).toBe(phase === 'prepared')
      expect(sink).not.toHaveBeenCalled()
    } finally {
      releaseOther()
      await f.close()
    }
  },
)

test.each([
  { ordinal: 0, disposition: 'committed' },
  { ordinal: 2, disposition: 'committed' },
  { ordinal: Number.MAX_SAFE_INTEGER + 1, disposition: 'committed' },
  { ordinal: 1, disposition: 'other' },
  { ordinal: 1, disposition: 'replayed' },
  { ordinal: 1, disposition: 'committed', extra: true },
])(
  'physical acknowledgement validation rejects $disposition ordinal $ordinal',
  async (value) => {
    const f = fixture(async () => value as never),
      attempt = f.records.beginAttempt([root], true)
    try {
      await expect(
        f.records.commit(
          'terminal',
          [entry('terminal')],
          [],
          undefined,
          true,
          Infinity,
          attempt,
        ),
      ).rejects.toBeDefined()
      expect(attempt.latest).toMatchObject({
        phase: 'entered',
        physical: 'invalid_ack',
      })
      expect(attempt.physicalSettled).toBe(true)
      expect(f.records.ordinal).toBe(0)
      await f.records.drain(root).catch(() => {})
      const error = new KimiCompletionPersistenceError(
        identity(),
        root,
        attempt,
        attempt,
        (historical) => f.records.requiredEvidence(root, attempt, historical),
      )
      expect(isCompletionPersistenceFailure(error)).toBe(true)
      expect(error.persistence).toMatchObject({
        code: 'persistence_unknown',
        classification: 'invalid_ack',
      })
    } finally {
      await f.close()
    }
  },
)

test('a foreign operation retains its own IDs and the original unavailable sink cause', async () => {
  const gate = deferred<void>(),
    entered = deferred<void>(),
    underlying = new Error('Original private sink failure'),
    sink = vi.fn<KimiRecordSink>(async () => {
      entered.resolve()
      await gate.promise
      throw underlying
    }),
    f = fixture(sink)
  const other = {
      runId: 'run-b',
      turnId: 'turn-b',
      operationId: 'operation-b',
    },
    a = f.records.beginAttempt([root]),
    b = f.records.beginAttempt([other], true)
  try {
    const first = f.records.commit(
      'a',
      [entry('a')],
      [],
      undefined,
      false,
      Infinity,
      a,
    )
    const second = f.records.commit(
      'b',
      [entry('b', other)],
      [],
      undefined,
      true,
      Infinity,
      b,
    )
    void first.catch(() => {})
    void second.catch(() => {})
    await entered.promise
    gate.resolve()
    await expect(first).rejects.toBe(underlying)
    await expect(second).rejects.toBe(underlying)
    await f.records.drain(other).catch(() => {})
    expect(sink).toHaveBeenCalledTimes(1)
    expect(b.latest.phase).toBe('constructed')
    expect(b.cause).toBe(a)
    const error = new KimiCompletionPersistenceError(
      identity(other),
      other,
      a,
      b,
      (historical) => f.records.requiredEvidence(other, b, historical),
    )
    expect(error.underlying).toBe(underlying)
    expect(error.persistence).toMatchObject({
      ...identity(other),
      cause: {
        relation: 'session_fence',
        owner: { operationId: root.operationId },
      },
      failure: { phase: 'entered', physical: 'rejected' },
      required: { state: 'unproved', terminal: { phase: 'constructed' } },
    })
  } finally {
    gate.resolve()
    await f.close()
  }
})

test('late physical acknowledgement updates recovery without mutating the earlier rejection snapshot', async () => {
  const gate = deferred<{ ordinal: number; disposition: 'committed' }>(),
    entered = deferred<void>(),
    f = fixture(
      async () => {
        entered.resolve()
        return gate.promise
      },
      { sinkMs: 20 },
    )
  const attempt = f.records.beginAttempt([root], true)
  try {
    const work = f.records.commit(
      'terminal',
      [entry('terminal')],
      [],
      undefined,
      true,
      Infinity,
      attempt,
    )
    void work.catch(() => {})
    await entered.promise
    await expect(work).rejects.toMatchObject({ code: 'kimi_deadline' })
    await f.records.drain(root).catch(() => {})
    const error = new KimiCompletionPersistenceError(
      identity(),
      root,
      attempt,
      attempt,
      (historical) => f.records.requiredEvidence(root, attempt, historical),
    )
    const snapshot = JSON.stringify(error.persistence)
    expect(f.host.budget.count('sinkCalls')).toBe(1)
    gate.resolve({ ordinal: 1, disposition: 'committed' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(f.host.budget.count('sinkCalls')).toBe(0)
    expect(error.recovery()).toMatchObject({
      state: 'unresolved',
      failure: { phase: 'acknowledged', acknowledgement: { ordinal: 1 } },
      required: { state: 'committed' },
    })
    expect(JSON.stringify(error.persistence)).toBe(snapshot)
  } finally {
    gate.resolve({ ordinal: 1, disposition: 'committed' })
    await f.close()
  }
})

test('post-ack publication preserves partial effects and does not set the unavailable sink fence', async () => {
  const original = new Error('Private emit failure'),
    events: unknown[] = [],
    sink = vi.fn<KimiRecordSink>(async (input) => ({
      ordinal: input.expectedOrdinal + 1,
      disposition: 'committed',
    }))
  const f = fixture(sink, {}, (event) => {
      events.push(event)
      if (events.length === 2) throw original
    }),
    attempt = f.records.beginAttempt([root], true)
  const event = {
    ...root,
    runtimeGeneration: scope.runtimeGeneration,
    deliveryId: '',
    itemId: 'notice',
    type: 'diagnostic',
    severity: 'error',
    code: 'synthetic',
    message: 'synthetic',
  } as const
  try {
    await expect(
      f.records.commit(
        'terminal',
        [entry('terminal')],
        [event, { ...event, itemId: 'second' }],
        undefined,
        true,
        Infinity,
        attempt,
      ),
    ).rejects.toBe(original)
    await f.records.drain(root).catch(() => {})
    const error = new KimiCompletionPersistenceError(
      identity(),
      root,
      attempt,
      attempt,
      (historical) => f.records.requiredEvidence(root, attempt, historical),
    )
    expect(error.underlying).toBe(original)
    expect(error.persistence).toMatchObject({
      code: 'completion_publication_failed',
      failure: {
        phase: 'acknowledged',
        publication: {
          state: 'stopped',
          attemptedEvents: 2,
          returnedEvents: 1,
        },
      },
      required: { state: 'committed' },
    })
    expect(f.records.terminalWritable).toBe(true)
    const other = { ...root, operationId: 'other' }
    await expect(
      f.records.commit('other', [entry('other', other)], [], undefined, true),
    ).resolves.toBe(2)
    expect(sink).toHaveBeenCalledTimes(2)
  } finally {
    await f.close()
  }
})

test('actual completed finalization rejects publication failure without writing a contradictory terminal', async () => {
  const underlying = new Error('Original completion publication failure'),
    emitted: unknown[] = [],
    sink = vi.fn<KimiRecordSink>(async (input) => ({
      ordinal: input.expectedOrdinal + 1,
      disposition: 'committed',
    }))
  const f = fixture(sink, {}, (event) => {
      emitted.push(event)
      throw underlying
    }),
    transcript = new KimiTranscript(f.records, async () => {}),
    completion = createCompletionHandle(identity(), {
      persistenceRejection: true,
    })
  const op = {
    root,
    identity: identity(),
    providerTurn: 'native-turn',
    settled: false,
    release() {},
    candidateReleases: [],
    completion,
    terminal: deferred<void>(),
  }
  const runtime = Object.create(KimiRuntime.prototype)
  Object.assign(runtime, {
    generation: scope.runtimeGeneration,
    host: f.host,
    budget: f.budget,
    records: f.records,
    transcript,
    interactions: { expire: async () => {} },
    operations: new Map([['operation', op]]),
  })
  const before = f.host.budget.count('hostRetainedBytes')
  try {
    const finishing = runtime.finish(op, { status: 'completed' })
    expect(runtime.finish(op, { status: 'completed' })).toBe(finishing)
    const observed = finishing.catch((error: unknown) => error)
    const error = await completion.handle.catch((value: unknown) => value)
    expect(await observed).toBe(error)
    expect(error).toBeInstanceOf(KimiCompletionPersistenceError)
    const failure = error as KimiCompletionPersistenceError
    expect(failure.underlying).toBe(underlying)
    expect(failure.persistence).toMatchObject({
      code: 'completion_publication_failed',
      classification: 'publication_failed',
      failure: {
        phase: 'acknowledged',
        publication: {
          state: 'stopped',
          attemptedEvents: 1,
          returnedEvents: 0,
        },
      },
      required: { state: 'committed' },
    })
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0][0].records[0]).toMatchObject({
      kind: 'turn.terminal',
      payload: { outcome: { status: 'completed' } },
    })
    expect(emitted).toHaveLength(1)
    expect(failure.terminalAttempt.input).toBe(sink.mock.calls[0][0])
    expect(failure.terminalAttempt.physicalSettled).toBe(true)
    expect(f.host.budget.count('hostRetainedBytes')).toBeGreaterThan(before)
    expect(f.host.budget.count('sinkCalls')).toBe(0)
    runtime.failOperation(op, new Error('Late failure'))
    expect(sink).toHaveBeenCalledTimes(1)
  } finally {
    transcript.close()
    await f.close()
  }
})

test.each([false, true])(
  'actual failure finalization preserves aggregate coverage with blocked prerequisite: %s',
  async (blockedOrdinaryWrite) => {
    const underlying = new Error('Original acknowledged publication failure')
    let emitted = 0
    const sink = vi.fn<KimiRecordSink>(async (input) => ({
      ordinal: input.expectedOrdinal + 1,
      disposition: 'committed',
    }))
    const f = fixture(sink, {}, () => {
      if (++emitted === 1) throw underlying
    })
    const completion = createCompletionHandle(identity(), {
      persistenceRejection: true,
    })
    const op = {
      root,
      identity: identity(),
      completion,
      providerTurn: 'native-turn',
      settled: false,
      candidateReleases: [],
      candidates: [],
      input: [],
      release: vi.fn(),
      acceptance: { resolve: vi.fn() },
      delivery: { resolve: vi.fn() },
      terminal: deferred<void>(),
      finalizing: undefined as Promise<void> | undefined,
    }
    const runtime = Object.create(KimiRuntime.prototype)
    Object.assign(runtime, {
      generation: scope.runtimeGeneration,
      records: f.records,
      host: f.host,
      budget: f.budget,
      failureDiagnostic: false,
      interactions: { expire: async () => {} },
      transcript: { finishOwner: vi.fn() },
      operations: new Map([['receipt', op]]),
    })
    let rejection: unknown
    let rejected = 0
    const observed = completion.handle.catch((error) => {
      rejection = error
      rejected++
    })
    const cause = f.records.beginAttempt([root])
    const missing = blockedOrdinaryWrite
      ? f.records.beginAttempt([root])
      : undefined
    try {
      await expect(
        f.records.commit(
          'publication',
          [entry('publication')],
          [
            {
              type: 'diagnostic',
              severity: 'error',
              code: 'synthetic',
              message: 'synthetic',
              ...root,
              runtimeGeneration: scope.runtimeGeneration,
              deliveryId: '',
              itemId: 'item',
            },
          ],
          undefined,
          false,
          Infinity,
          cause,
        ),
      ).rejects.toBe(underlying)
      if (missing)
        await expect(
          f.records.commit(
            'blocked',
            [entry('blocked')],
            [],
            undefined,
            false,
            Infinity,
            missing,
          ),
        ).rejects.toBe(underlying)
      runtime.failOperation(op, underlying)
      const finalizerError = await op.finalizing!.catch((error) => error)
      await expect.poll(() => rejected).toBe(1)
      await observed
      expect(finalizerError).toBe(rejection)
      expect(rejection).toBeInstanceOf(KimiCompletionPersistenceError)
      const error = rejection as KimiCompletionPersistenceError
      expect(error.underlying).toBe(underlying)
      expect(error.failureAttempt).toBe(cause)
      expect(error.persistence).toMatchObject({
        ...identity(),
        code: blockedOrdinaryWrite
          ? 'completion_not_committed'
          : 'completion_publication_failed',
        classification: 'publication_failed',
        failure: { phase: 'acknowledged', acknowledgement: { ordinal: 1 } },
        required: {
          state: blockedOrdinaryWrite ? 'not_committed' : 'committed',
          terminal: { phase: 'acknowledged', acknowledgement: { ordinal: 2 } },
        },
      })
      if (missing) {
        expect(missing.latest.phase).toBe('constructed')
        expect(missing.cause).toBe(cause)
        expect(error.recovery().required.state).toBe('not_committed')
      }
      expect(sink).toHaveBeenCalledTimes(2)
      expect(op.settled).toBe(true)
      runtime.failOperation(op, new Error('Later failure'))
      expect(rejected).toBe(1)
      expect(op.release).toHaveBeenCalledTimes(1)
    } finally {
      await f.close()
    }
  },
)

test('post-ack deadline keeps the exact CAS position and zero publication calls', async () => {
  let now = 0
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now),
    emit = vi.fn(),
    f = fixture(
      async (input) => {
        now = 20
        return { ordinal: input.expectedOrdinal + 1, disposition: 'committed' }
      },
      {},
      emit,
    ),
    attempt = f.records.beginAttempt([root], true)
  try {
    await expect(
      f.records.commit(
        'deadline',
        [entry('deadline')],
        [],
        undefined,
        true,
        10,
        attempt,
      ),
    ).rejects.toMatchObject({ code: 'kimi_history_deadline' })
    await f.records.drain(root).catch(() => {})
    const error = new KimiCompletionPersistenceError(
      identity(),
      root,
      attempt,
      attempt,
      (historical) => f.records.requiredEvidence(root, attempt, historical),
    )
    expect(error.persistence).toMatchObject({
      code: 'completion_publication_failed',
      classification: 'publication_deadline',
      failure: {
        lastAcknowledged: { ordinal: 0 },
        acknowledgement: { ordinal: 1 },
        publication: {
          state: 'stopped',
          attemptedEvents: 0,
          returnedEvents: 0,
        },
      },
      required: { state: 'committed', sealedThrough: { ordinal: 1 } },
    })
    expect(emit).not.toHaveBeenCalled()
    expect(f.records.ordinal).toBe(1)
  } finally {
    clock.mockRestore()
    await f.close()
  }
})

test('late acknowledgement before completion publication preserves the failed phase and exposes the new recovery fact', async () => {
  const gate = deferred<{ ordinal: number; disposition: 'committed' }>(),
    f = fixture(async () => gate.promise, { sinkMs: 20 }),
    attempt = f.records.beginAttempt([root], true)
  try {
    await expect(
      f.records.commit(
        'late',
        [entry('late')],
        [],
        undefined,
        true,
        Infinity,
        attempt,
      ),
    ).rejects.toMatchObject({ code: 'kimi_deadline' })
    expect(attempt.failureEvidence).toMatchObject({
      phase: 'entered',
      physical: 'pending',
    })
    const captured = attempt.failureEvidence
    gate.resolve({ ordinal: 1, disposition: 'committed' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    await f.records.drain(root).catch(() => {})
    expect(attempt.latest.phase).toBe('acknowledged')
    const error = new KimiCompletionPersistenceError(
      identity(),
      root,
      attempt,
      attempt,
      (historical) => f.records.requiredEvidence(root, attempt, historical),
    )
    expect(error.persistence).toMatchObject({
      code: 'persistence_unknown',
      classification: 'logical_deadline',
      failure: { phase: 'entered', physical: 'pending' },
      required: { state: 'unproved' },
    })
    expect(error.recovery()).toMatchObject({
      required: { state: 'committed' },
      failure: { phase: 'acknowledged' },
    })
    expect(attempt.failureEvidence).toBe(captured)
  } finally {
    gate.resolve({ ordinal: 1, disposition: 'committed' })
    await f.close()
  }
})

test('retirement after acknowledgement stops publication and keeps the committed evidence', async () => {
  const emit = vi.fn()
  const f = fixture(
    async (input) => {
      f.records.retire()
      return { ordinal: input.expectedOrdinal + 1, disposition: 'committed' }
    },
    {},
    emit,
  )
  const attempt = f.records.beginAttempt([root], true)
  const event = {
    type: 'turn_completed' as const,
    runId: root.runId,
    turnId: root.turnId,
    runtimeGeneration: scope.runtimeGeneration,
    deliveryId: '',
    outcome: { status: 'completed' as const },
  }
  try {
    await expect(
      f.records.commit(
        'retiring',
        [entry('retiring')],
        [event],
        undefined,
        false,
        Infinity,
        attempt,
      ),
    ).rejects.toMatchObject({ code: 'kimi_generation_retired' })
    await f.records.drain(root).catch(() => {})
    const error = new KimiCompletionPersistenceError(
      identity(),
      root,
      attempt,
      attempt,
      (historical) => f.records.requiredEvidence(root, attempt, historical),
    )
    expect(error.persistence).toMatchObject({
      code: 'completion_publication_failed',
      required: { state: 'committed' },
      failure: {
        publication: {
          state: 'stopped',
          attemptedEvents: 0,
          returnedEvents: 0,
        },
      },
    })
    expect(emit).not.toHaveBeenCalled()
    expect(attempt.input).toBeDefined()
    expect(f.records.ordinal).toBe(1)
  } finally {
    await f.close()
  }
})
