import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { defineConfig, devices } from '@playwright/test'

// Several checkouts of this repository run the gate at the same time, and a
// killed run can leak its dev server. A fixed port makes both cases fail with
// "port is already used", so derive a stable port per checkout instead.
const checkout = fileURLToPath(new URL('.', import.meta.url))
const digest = createHash('sha256').update(checkout).digest()
const port = Number(
  process.env.FORGE_E2E_PORT ?? 5200 + (digest.readUInt16BE(0) % 700),
)
const origin = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './specs',
  workers: 1,
  fullyParallel: false,
  // The mock Bun server intermittently resets a connection (ECONNRESET)
  // with no crash log; one retry absorbs the harness flake.
  retries: 1,
  reporter: 'line',
  webServer: {
    command: `bun run --cwd ../apps/web dev --host 127.0.0.1 --port ${port}`,
    url: origin,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  use: { baseURL: origin, trace: 'on-first-retry' },
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: 'phone',
      use: { ...devices['Pixel 5'], viewport: { width: 390, height: 844 } },
    },
  ],
})
