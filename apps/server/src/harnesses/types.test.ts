import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  createCompletionHandle,
  type ConfirmedNativeBinding,
  type HarnessHandle,
  type NativeBinding,
} from './types.js'

describe('native completion handles', () => {
  it('waits for the provider settlement result', async () => {
    const { handle, settle } = createCompletionHandle({
      completionId: 'c1',
      runId: 'r1',
      turnId: 't1',
    })
    let settled = false
    const result = handle.then((value) => {
      settled = true
      return value
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    settle({
      status: 'failed',
      runId: 'r1',
      turnId: 't1',
      code: 'E_FAIL',
      message: 'failed',
    })
    await expect(result).resolves.toMatchObject({ status: 'failed' })
    expect(handle.completionId).toBe('c1')
  })
})

describe('completion settlement identity and outcome', () => {
  it('retains the first interrupted outcome across duplicate settlements', async () => {
    const { handle, settle } = createCompletionHandle({
      completionId: 'c',
      runId: 'r',
      turnId: 't',
    })
    const first = {
      status: 'interrupted' as const,
      runId: 'r',
      turnId: 't',
      reason: 'user cancelled',
    }
    settle(first)
    settle({ status: 'completed', runId: 'r', turnId: 't' })
    await expect(handle).resolves.toEqual(first)
  })

  it('rejects malformed or mismatched settlement without resolving the handle', async () => {
    const { handle, settle } = createCompletionHandle({
      completionId: 'c',
      runId: 'r',
      turnId: 't',
    })
    let finished = false
    void handle.then(() => {
      finished = true
    })
    expect(() =>
      settle({ status: 'failed', runId: 'r', turnId: 't' } as never),
    ).toThrow()
    expect(() =>
      settle({ status: 'completed', runId: 'other', turnId: 't' }),
    ).toThrow()
    expect(() =>
      settle({ status: 'completed', runId: 'r', turnId: 'other' }),
    ).toThrow()
    await Promise.resolve()
    expect(finished).toBe(false)
    settle({ status: 'completed', runId: 'r', turnId: 't' })
    await expect(handle).resolves.toMatchObject({ status: 'completed' })
  })
})

describe('native binding type contract', () => {
  it('requires a readonly nullable confirmed binding on every handle', () => {
    expectTypeOf<Pick<HarnessHandle, 'binding'>>().toEqualTypeOf<{
      readonly binding: ConfirmedNativeBinding | null
    }>()
    expectTypeOf<ConfirmedNativeBinding>().toEqualTypeOf<{
      readonly provider: string
      readonly accountId: string | null
      readonly cwd: string
      readonly providerSessionId: string
    }>()
    expectTypeOf<NativeBinding['providerSessionId']>().toEqualTypeOf<
      string | null
    >()
    const startupBinding = null satisfies HarnessHandle['binding']
    expect(startupBinding).toBeNull()
  })
})
