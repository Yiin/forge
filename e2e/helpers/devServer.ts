import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/**
 * The port the Vite dev server listens on.
 *
 * Several checkouts run the gate at once, so the port is derived from the
 * checkout path rather than fixed. The Playwright config and the Forge launch
 * helper both need it: one to start the dev server, the other to let the
 * isolated Forge server accept that origin.
 */
export function devServerPort(): number {
  const checkout = fileURLToPath(new URL('..', import.meta.url))
  const digest = createHash('sha256').update(checkout).digest()
  return Number(
    process.env.FORGE_E2E_PORT ?? 5200 + (digest.readUInt16BE(0) % 700),
  )
}

export function devServerOrigin(): string {
  return `http://127.0.0.1:${devServerPort()}`
}
