import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validateDatabasePath } from './forge-sqlite'

describe('forge sqlite guard', () => {
  it('rejects databases outside the temporary directory', () => {
    expect(() => validateDatabasePath('/var/lib/forge.db')).toThrow(
      /Refusing database path/,
    )
    expect(() =>
      validateDatabasePath(join(tmpdir(), 'forge-e2e', 'state.sqlite')),
    ).toThrow()
  })
})
