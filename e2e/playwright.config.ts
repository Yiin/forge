import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './specs',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: 'line',
  webServer: {
    command: 'bun run --cwd ../apps/web dev --host 127.0.0.1 --port 5173',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false,
    timeout: 30_000,
  },
  use: { baseURL: 'http://127.0.0.1:5173', trace: 'on-first-retry' },
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
