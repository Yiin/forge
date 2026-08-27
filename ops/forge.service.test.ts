import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

describe('forge service environment', () => {
  it('exposes every managed harness CLI directory on PATH', async () => {
    const unit = await readFile(
      join(process.cwd(), 'ops/forge.service'),
      'utf8',
    )
    const pathLine = unit
      .split('\n')
      .find((line) => line.startsWith('Environment=PATH='))

    expect(pathLine).toBe(
      'Environment=PATH=%h/.vite-plus/js_runtime/node/24.20.0/bin:%h/.local/bin:%h/.vite-plus/bin:%h/.kimi-code/bin:%h/.opencode/bin:%h/.bun/bin:/usr/local/bin:/usr/bin:/bin',
    )

    for (const directory of [
      '%h/.local/bin',
      '%h/.vite-plus/bin',
      '%h/.kimi-code/bin',
      '%h/.opencode/bin',
    ]) {
      expect(pathLine).toContain(directory)
    }
  })
})
