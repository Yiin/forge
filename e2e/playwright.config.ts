import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './specs',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: 'line',
  use: { trace: 'on-first-retry' },
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
      use: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } },
    },
  ],
})
