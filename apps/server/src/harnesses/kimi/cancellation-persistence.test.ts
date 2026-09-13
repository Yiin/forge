import { expect, test } from 'vitest'
import { KimiRuntime } from './runtime.js'
import { KimiHostOwner } from './host.js'
import { KimiBudget } from './limits.js'
import { isCompletionPersistenceFailure } from '../types.js'
import type { KimiCompletionPersistenceError } from './persistence.js'
import type { KimiLimits } from './limits.js'
import type { KimiRecordSink } from './types.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function fixture(
  result: 'ack' | 'reject' | 'timeout',
  limits: Partial<KimiLimits> = {},
  heldHook = false,
) {
  const host = new KimiHostOwner({ limits }),
    budget = new KimiBudget(host.budget.limits)
  const gate = deferred(),
    entered = deferred(),
    done = deferred(),
    hook = deferred(),
    hookEntered = deferred()
  const underlying = new Error('Original synthetic sink rejection')
  let closedLeases = 0,
    providerPosts = 0,
    terminalCalls = 0
  const server = {
    done: done.promise,
    cleanupProved: false,
    http: async (
      _lane: string,
      path: string,
      options: { method?: string } = {},
    ) => {
      if (options.method === 'POST') {
        providerPosts++
        throw new Error('Native POST is forbidden in this fixture')
      }
      if (path.endsWith('/prompts')) return { active: null, queued: [] }
      if (path.includes('/messages?')) return { items: [], has_more: false }
      throw new Error('Unexpected synthetic route')
    },
    closeSocket: async () => {},
  }
  const runtime = Reflect.construct(KimiRuntime, [
    { id: 'review', cwd: '/inert', provider: 'kimi', accountId: 'synthetic' },
    { selected: { account: { config: {} } }, environment: {} },
    host,
    {
      server,
      lane: 'lane',
      close: async () => {
        closedLeases++
        server.cleanupProved = true
        done.resolve()
      },
    },
    {
      provider: 'kimi',
      accountId: 'synthetic',
      cwd: '/inert',
      providerSessionId: 'native',
    },
    {
      version: '0.34.0',
      models: [],
      commands: { status: 'unsupported', reason: 'synthetic' },
    },
    {
      beforeDispatch: async () => {
        if (heldHook) {
          hookEntered.resolve()
          await hook.promise
          return
        }
        throw new Error('Original synthetic dispatch failure')
      },
      commitRecords: async (input: Parameters<KimiRecordSink>[0]) => {
        terminalCalls++
        entered.resolve()
        await gate.promise
        if (result === 'reject') throw underlying
        return { ordinal: input.expectedOrdinal + 1, disposition: 'committed' }
      },
    },
    () => {},
    budget,
  ]) as KimiRuntime
  Object.assign(runtime, {
    cut: async () => {},
    replay: { cursor: { seq: 0 }, dispose() {} },
    snapshot: {
      in_flight_turn: null,
      pending_questions: [],
      pending_approvals: [],
    },
  })
  const owner = runtime as unknown as {
    operations: Map<
      string,
      { preparing: boolean; finalizing?: Promise<void>; settled: boolean }
    >
    released: boolean
  }
  return {
    runtime,
    owner,
    host,
    gate,
    entered,
    hook,
    hookEntered,
    underlying,
    state: () => ({
      closedLeases,
      providerPosts,
      terminalCalls,
      sinkCalls: host.budget.count('sinkCalls'),
    }),
    close: async () => {
      gate.resolve()
      hook.resolve()
      server.cleanupProved = true
      done.resolve()
      await host.close()
      await tick()
      expect(host.budget.count('sinkCalls')).toBe(0)
      expect(host.budget.count('hostRetainedBytes')).toBe(0)
    },
  }
}

test.each(['ack', 'reject', 'timeout'] as const)(
  'preparing cancel and kill join held failure finalization through %s',
  async (result) => {
    const f = fixture(result, {
      sinkMs: result === 'timeout' ? 30 : 1000,
      shutdownMs: 500,
    })
    const receipt = f.runtime.prompt('Synthetic prompt')
    let completion: unknown,
      completionSettled = false,
      cancelSettled = false,
      killSettled = false
    const observed = receipt.completion.then(
      (value) => {
        completion = value
        completionSettled = true
      },
      (error) => {
        completion = error
        completionSettled = true
      },
    )
    try {
      await f.entered.promise
      const operation = f.owner.operations.get(receipt.receiptId)!
      expect(operation.preparing).toBe(true)
      expect(operation.finalizing).toBeDefined()
      const cancel = f.runtime.cancel().then(
        () => {
          cancelSettled = true
        },
        (error) => {
          cancelSettled = true
          return error
        },
      )
      const kill = f.runtime.kill().then(
        () => {
          killSettled = true
        },
        (error) => {
          killSettled = true
          return error
        },
      )
      await tick()
      expect(completionSettled).toBe(false)
      expect(cancelSettled).toBe(false)
      expect(killSettled).toBe(false)
      expect(f.state()).toMatchObject({
        closedLeases: 0,
        providerPosts: 0,
        terminalCalls: 1,
        sinkCalls: 1,
      })
      if (result !== 'timeout') f.gate.resolve()
      await observed
      if (result === 'ack') {
        expect(completion).toMatchObject({
          status: 'failed',
          runId: receipt.runId,
          turnId: receipt.turnId,
        })
        expect(await cancel).toBeUndefined()
        expect(await kill).toBeUndefined()
        expect(f.state().closedLeases).toBe(1)
      } else {
        expect(isCompletionPersistenceFailure(completion)).toBe(true)
        expect(await cancel).toBe(completion)
        expect(await kill).toBe(completion)
        expect(f.owner.released).toBe(false)
        expect(f.owner.operations.size).toBe(1)
        expect(f.state().closedLeases).toBe(0)
        expect((completion as KimiCompletionPersistenceError).code).toBe(
          'persistence_unknown',
        )
        if (result === 'reject')
          expect(
            (completion as KimiCompletionPersistenceError).underlying,
          ).toBe(f.underlying)
        else expect(f.state().sinkCalls).toBe(1)
      }
      expect(f.state().terminalCalls).toBe(1)
      expect(f.state().providerPosts).toBe(0)
    } finally {
      await f.close()
      await observed
    }
  },
)

test('cancellation deadline keeps the original finalizer, sink call, operation, and lease', async () => {
  const f = fixture('reject', { shutdownMs: 20, sinkMs: 500 })
  const receipt = f.runtime.prompt('Synthetic prompt')
  const completion = receipt.completion.catch((error) => error)
  try {
    await f.entered.promise
    const operation = f.owner.operations.get(receipt.receiptId)!
    const originalFinalizer = operation.finalizing
    await expect(f.runtime.cancel()).rejects.toMatchObject({
      code: 'kimi_cleanup_uncertain',
    })
    expect(operation.finalizing).toBe(originalFinalizer)
    expect(f.state()).toMatchObject({
      sinkCalls: 1,
      closedLeases: 0,
      terminalCalls: 1,
    })
    expect(f.owner.operations.get(receipt.receiptId)).toBe(operation)
    await expect(f.runtime.kill()).rejects.toMatchObject({
      code: 'kimi_cleanup_uncertain',
    })
    f.gate.resolve()
    const error = await completion
    expect(isCompletionPersistenceFailure(error)).toBe(true)
    await expect(f.runtime.cancel()).rejects.toBe(error)
    await expect(f.runtime.kill()).rejects.toBe(error)
    expect(f.state().closedLeases).toBe(0)
  } finally {
    await f.close()
    await completion
  }
})

test('successful pre-dispatch cancellation still prevents native submission and joins its terminal', async () => {
  const f = fixture('ack', { sinkMs: 1000, shutdownMs: 500 }, true)
  const receipt = f.runtime.prompt('Synthetic prompt')
  try {
    await f.hookEntered.promise
    let stopped = false
    const cancel = f.runtime.cancel().then(() => {
      stopped = true
    })
    await f.entered.promise
    expect(stopped).toBe(false)
    f.gate.resolve()
    await cancel
    await expect(receipt.nativeAcceptance).resolves.toMatchObject({
      status: 'rejected',
    })
    await expect(receipt.delivery).resolves.toMatchObject({
      status: 'not_delivered',
    })
    await expect(receipt.completion).resolves.toMatchObject({
      status: 'failed',
    })
    expect(f.state()).toMatchObject({ providerPosts: 0, terminalCalls: 1 })
    // The hook ignored cancellation and remains physically owned until release.
    expect(f.state().sinkCalls).toBe(1)
    f.hook.resolve()
  } finally {
    await f.close()
  }
})
