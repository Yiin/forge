import { describe, expect, it, vi } from 'vitest'
import { openGrokPolicySession } from './policy.js'
import { AcpResourceHost } from './limits.js'
import { deferred } from '../transport-test-helpers.js'
import { createCompletionHandle, type HarnessHandle } from '../types.js'
const session = { id: 's', provider: 'instance', cwd: '/var/tmp' }
function peer(): HarnessHandle {
  return {
    binding: {
      provider: 'instance',
      accountId: null,
      cwd: '/var/tmp',
      providerSessionId: 'native',
    },
    prompt: vi.fn(() => {
      const c = createCompletionHandle({
        completionId: 'c',
        runId: 'r',
        turnId: 't',
      })
      c.settle({ status: 'completed', runId: 'r', turnId: 't' })
      return {
        receiptId: 'receipt',
        runId: 'r',
        turnId: 't',
        completion: c.handle,
      }
    }),
    cancel: vi.fn(async () => {}),
    kill: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    setConfigOption: vi.fn(async () => {}),
  }
}
async function setup(
  replace: (handle: HarnessHandle, policy: 'manual' | 'yolo') => Promise<void>,
  old = peer(),
) {
  const host = new AcpResourceHost(),
    open = vi.fn(async () => old)
  const handle = await openGrokPolicySession(
    open,
    session,
    () => {},
    false,
    host,
    'instance',
    () => false,
    replace,
  )
  return { host, open, handle, old }
}
describe('Grok original policy replacement ownership', () => {
  it('expires waiting input without admitting it after the old receipt finishes', async () => {
    vi.useFakeTimers()
    const old = peer(),
      c = createCompletionHandle({
        completionId: 'held',
        runId: 'r',
        turnId: 't',
      }),
      replace = vi.fn(async () => {})
    old.prompt = vi.fn(() => ({
      receiptId: 'receipt',
      runId: 'r',
      turnId: 't',
      completion: c.handle,
    }))
    const f = await setup(replace, old)
    try {
      await f.handle.prompt('first')
      const pending = Promise.resolve(
        f.handle.prompt('expired', { permissionMode: 'yolo' }),
      )
      const observed = expect(pending).rejects.toThrow('expired')
      await vi.advanceTimersByTimeAsync(300000)
      await observed
      c.settle({ status: 'completed', runId: 'r', turnId: 't' })
      await f.handle.kill()
      expect(replace).not.toHaveBeenCalled()
      expect(old.prompt).toHaveBeenCalledTimes(1)
    } finally {
      await f.handle.kill()
      vi.useRealTimers()
    }
  })
  it('does not dispatch an expired configuration after the original control settles', async () => {
    vi.useFakeTimers()
    const old = peer(),
      gate = deferred<void>(),
      entered = deferred<void>()
    old.setModel = vi.fn(async () => {
      entered.resolve()
      await gate.promise
    })
    const f = await setup(async () => {}, old)
    try {
      const model = Promise.resolve(f.handle.setModel!('held'))
      await entered.promise
      const config = Promise.resolve(
        f.handle.setConfigOption!('expired', 'value'),
      )
      const settled = Promise.allSettled([model, config])
      await vi.advanceTimersByTimeAsync(300000)
      expect(
        (await settled).every((result) => result.status === 'rejected'),
      ).toBe(true)
      gate.resolve()
      await f.handle.kill()
      expect(old.setConfigOption).not.toHaveBeenCalled()
    } finally {
      gate.resolve()
      await f.handle.kill()
      vi.useRealTimers()
    }
  })
  it('holds captured input behind replacement without replacing the session handle', async () => {
    const entered = deferred<void>(),
      gate = deferred<void>()
    const replace = vi.fn(async () => {
      entered.resolve()
      await gate.promise
    })
    const f = await setup(replace)
    try {
      const input = [{ type: 'text' as const, text: 'original' }]
      const work = Promise.resolve(
        f.handle.prompt(input, { permissionMode: 'yolo' }),
      )
      await entered.promise
      input[0]!.text = 'changed'
      expect(f.old.prompt).not.toHaveBeenCalled()
      gate.resolve()
      await work
      expect(replace).toHaveBeenCalledWith(f.old, 'yolo')
      expect(f.old.prompt).toHaveBeenCalledWith(
        [{ type: 'text', text: 'original' }],
        { permissionMode: 'yolo' },
        undefined,
      )
      expect(f.open).toHaveBeenCalledTimes(1)
      expect(f.old.kill).not.toHaveBeenCalled()
    } finally {
      gate.resolve()
      await f.handle.kill()
    }
  })
  it('orders model controls before replacement and bounds waiting configuration', async () => {
    const entered = deferred<void>(),
      gate = deferred<void>(),
      old = peer(),
      replace = vi.fn(async () => {})
    old.setModel = vi.fn(async () => {
      entered.resolve()
      await gate.promise
    })
    const f = await setup(replace, old)
    try {
      const model = f.handle.setModel!('model')
      await entered.promise
      const prompt = Promise.resolve(
        f.handle.prompt('next', { permissionMode: 'yolo' }),
      )
      const changes = Array.from({ length: 7 }, () =>
        f.handle.setConfigOption!('mode', 'value'),
      )
      expect(() => f.handle.setConfigOption!('ninth', 'value')).toThrow(
        'admission limit',
      )
      expect(replace).not.toHaveBeenCalled()
      gate.resolve()
      await model
      await prompt
      await Promise.all(changes)
      expect(replace).toHaveBeenCalledTimes(1)
    } finally {
      gate.resolve()
      await f.handle.kill()
    }
  })
  it('publishes one close promise before a synchronous cancel callback reenters', async () => {
    const f = await setup(async () => {})
    let repeated: ReturnType<HarnessHandle['kill']>
    f.old.cancel = vi.fn(() => {
      repeated = f.handle.kill()
    })
    const first = f.handle.kill()
    await first
    expect(repeated!).toBe(first)
    expect(f.old.cancel).toHaveBeenCalledTimes(1)
    expect(f.old.kill).toHaveBeenCalledTimes(1)
  })
  it('fences all waiting admissions after original replacement cleanup rejects', async () => {
    const entered = deferred<void>(),
      gate = deferred<void>()
    const f = await setup(async () => {
      entered.resolve()
      await gate.promise
      throw Error('cleanup refused')
    })
    const first = Promise.resolve(
        f.handle.prompt('one', { permissionMode: 'yolo' }),
      ),
      second = Promise.resolve(f.handle.prompt('two'))
    void first.catch(() => {})
    void second.catch(() => {})
    await entered.promise
    gate.resolve()
    await expect(first).rejects.toThrow('cleanup refused')
    await expect(second).rejects.toThrow('unavailable')
    expect(f.old.prompt).not.toHaveBeenCalled()
    await f.handle.kill()
    f.host.reserve('instance', 'retained', 128 * 1024 * 1024)()
  })
  it('closes a late replacement without accepting work after close', async () => {
    const entered = deferred<void>(),
      gate = deferred<void>()
    const f = await setup(async () => {
      entered.resolve()
      await gate.promise
    })
    const work = Promise.resolve(
      f.handle.prompt('one', { permissionMode: 'yolo' }),
    )
    void work.catch(() => {})
    await entered.promise
    const closing = f.handle.kill()
    gate.resolve()
    await expect(work).rejects.toThrow('unavailable')
    await closing
    expect(f.old.kill).toHaveBeenCalledTimes(1)
    expect(f.old.prompt).not.toHaveBeenCalled()
  })
})

it('exposes intentional lifetime retirement from the original runtime', async () => {
  let expired = false
  const original = peer()
  Object.defineProperty(original, 'requiresResume', { get: () => expired })
  const { handle } = await setup(async () => {}, original)
  try {
    expect(handle.requiresResume).toBe(false)
    expired = true
    expect(handle.requiresResume).toBe(true)
  } finally {
    await handle.kill()
  }
})
