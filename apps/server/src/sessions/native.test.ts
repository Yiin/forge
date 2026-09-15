import { describe, expect, it } from 'vitest'
import {
  createCompletionHandle,
  type HarnessAdapter,
} from '../harnesses/types.js'
import { nativeHarness } from './native.js'

describe('native session bridge', () => {
  it('keeps the provider completion authoritative and translates typed events', async () => {
    let emit!: (event: any) => void
    const completion = createCompletionHandle({
      completionId: 'completion-1',
      runId: 'run-1',
      turnId: 'turn-1',
    })
    const adapter = {
      kind: 'native',
      capabilities: {
        loadSession: false,
        steer: false,
        queue: false,
        cancel: true,
        permissions: false,
        questions: false,
        models: false,
      },
      spawn: async (_session: any, callback: any) => {
        emit = callback
        return {
          binding: {
            provider: 'fake',
            accountId: null,
            cwd: process.cwd(),
            providerSessionId: 'provider-1',
          },
          prompt: () => ({
            receiptId: 'receipt-1',
            runId: 'run-1',
            turnId: 'turn-1',
            completion,
          }),
          cancel() {},
          kill() {},
        }
      },
    } as unknown as HarnessAdapter
    const received: any[] = []
    const bridged = nativeHarness(adapter)
    const handle = await bridged.spawn(
      { id: 'session-1', cwd: process.cwd(), harness: 'fake' },
      (value) => received.push(value),
      () => undefined,
    )
    const delivered = Promise.resolve(handle.prompt('hello'))
    emit({ type: 'turn_started', turnId: 'turn-1' })
    emit({
      type: 'text_delta',
      turnId: 'turn-1',
      itemId: 'item-1',
      text: 'hello',
    })
    expect(received).toEqual([
      { type: 'turn_start', turnId: 'turn-1' },
      { type: 'text_delta', turnId: 'turn-1', itemId: 'item-1', text: 'hello' },
    ])
    let settled = false
    void delivered.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    completion.settle({ status: 'completed', runId: 'run-1', turnId: 'turn-1' })
    await delivered
    expect(settled).toBe(true)
  })
})
