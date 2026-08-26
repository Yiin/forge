import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'apps/*/test/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.tsx',
      'packages/*/test/**/*.test.ts',
      'e2e/scripts/**/*.test.ts',
      'ops/**/*.test.ts',
    ],
  },
})
