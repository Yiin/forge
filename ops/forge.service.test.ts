import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

describe('forge service environment', () => {
  it('leaves PATH to the host so one unit fits every host', async () => {
    const unit = await readFile(
      join(process.cwd(), 'ops/forge.service'),
      'utf8',
    )

    expect(
      unit.split('\n').some((line) => line.startsWith('Environment=PATH=')),
    ).toBe(false)
  })
})
