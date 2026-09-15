import { defineConfig, devices } from '@playwright/test'

import { devServerOrigin, devServerPort } from './helpers/devServer.js'

const port = devServerPort()
const origin = devServerOrigin()

export default defineConfig({
  testDir: './specs',
  workers: 1,
  fullyParallel: false,
  // Targeted stability runs disable retries to expose first-attempt failures.
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
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'phone',
      use: { ...devices['Pixel 5'], viewport: { width: 390, height: 844 } },
    },
    {
      name: 'phone-compact',
      use: { ...devices['Pixel 5'], viewport: { width: 320, height: 568 } },
    },
    {
      name: 'landscape',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 844, height: 390 },
      },
    },
    ...[620, 920, 1280].map((width) => ({
      name: `breakpoint-${width}`,
      testMatch: /integrated-ui\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width, height: 900 } },
    })),
  ],
})
