import { describe, expect, it } from 'vitest'
import { createCompletionHandle } from './types.js'

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
