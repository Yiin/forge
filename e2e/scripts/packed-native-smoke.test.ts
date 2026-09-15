import { expect, it, vi } from 'vitest'
import { closePackedServer } from '../../scripts/packed-native-smoke.mjs'

it('waits for the original packed server cleanup callback', async () => {
  let finish!: (error?: Error) => void
  const close = vi.fn((callback: typeof finish) => {
    finish = callback
  })
  let settled = false
  const pending = closePackedServer({ close }).then(() => {
    settled = true
  })
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(close).toHaveBeenCalledTimes(1)
  finish()
  await pending
  expect(settled).toBe(true)
})

it('preserves the exact refused cleanup error', async () => {
  const original = Error('Original cleanup refused')
  const close = vi.fn((callback: (error?: Error) => void) => callback(original))
  await expect(closePackedServer({ close })).rejects.toBe(original)
  expect(close).toHaveBeenCalledTimes(1)
})
