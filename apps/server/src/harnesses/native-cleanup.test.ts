import { expect, it } from 'vitest'
import { closeNativeDiscovery, NativeCleanupError } from './native-cleanup.js'

it('retains the original cleanup callback and joins concurrent retries without exposing errors', async () => {
  let calls = 0
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const cleanup = async () => {
    calls++
    if (calls === 1) throw Error('secret-token')
    await held
  }
  const error = await closeNativeDiscovery(cleanup).catch((error) => error)
  expect(error).toBeInstanceOf(NativeCleanupError)
  expect(error.message).toBe('Native cleanup failed')
  expect(error.cause).toBeUndefined()
  expect(JSON.stringify(error)).not.toContain('secret-token')
  const first = error.retryCleanup()
  expect(error.retryCleanup()).toBe(first)
  let settled = false
  void first.then(() => {
    settled = true
  })
  await Promise.resolve()
  expect(calls).toBe(2)
  expect(settled).toBe(false)
  release()
  await first
  expect(error.retryCleanup()).toBe(first)
  expect(calls).toBe(2)
})

it('retains refused cleanup as the same safe error', async () => {
  const error = new NativeCleanupError(async () => {
    throw Error('secret-token')
  })
  await expect(error.retryCleanup()).rejects.toBe(error)
  await expect(error.retryCleanup()).rejects.toBe(error)
})
