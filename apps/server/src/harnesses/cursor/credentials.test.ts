import { mkdtemp, writeFile, rm, rename, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { cursorLimits } from './limits.js'
import { boundedRead } from './store.js'
import {
  readCursorCredentials,
  validateStoredCredentials,
} from './credentials.js'
import type { CursorSelectedRecords } from './contracts.js'

const race = vi.hoisted(() => ({
  afterOpen: undefined as undefined | (() => Promise<void>),
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args),
        hook = race.afterOpen
      race.afterOpen = undefined
      try {
        await hook?.()
        return file
      } catch (error) {
        await file.close()
        throw error
      }
    },
  }
})
const limits = cursorLimits(),
  roots: string[] = []
const valid = {
  version: 1,
  backendUrl: 'https://api2.cursor.sh',
  apiKey: 'synthetic-key',
  createdAtMs: 0,
}
afterEach(async () => {
  race.afterOpen = undefined
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp('/tmp/forge-cursor-credentials-')
  roots.push(root)
  const path = join(root, 'auth.json')
  await writeFile(path, JSON.stringify(valid), { mode: 0o600 })
  const selected = {
    account: { homePath: root },
    credential: { type: 'sdk-file', path },
  } as CursorSelectedRecords
  return { root, path, selected }
}
it('rejects descriptor replacement and mode changes during a bounded credential read', async () => {
  for (const mutation of ['replace', 'mode']) {
    const { path } = await fixture()
    race.afterOpen = async () => {
      if (mutation === 'replace') {
        await rename(path, `${path}.original`)
        await writeFile(path, JSON.stringify(valid), { mode: 0o600 })
      } else await chmod(path, 0o644)
    }
    await expect(
      boundedRead(path, limits.credentialBytes, true),
    ).rejects.toThrow()
  }
})
it('keeps the credential amendment fields exact and rejects malformed, missing, nonfinite, and empty records', async () => {
  expect(
    validateStoredCredentials(
      { ...valid, createdAtMs: 1e100, apiKeyExpiresAtMs: 1.5 },
      limits,
    ),
  ).toMatchObject({ createdAtMs: 1e100, apiKeyExpiresAtMs: 1.5 })
  expect(
    validateStoredCredentials(
      { ...valid, apiKeyExpiresAtMs: 0, email: '', extra: 'ignored' },
      limits,
    ),
  ).toEqual({ ...valid, apiKeyExpiresAtMs: 0, email: '' })
  const { path, selected } = await fixture()
  for (const text of [
    '{',
    'null',
    '{}',
    JSON.stringify({ ...valid, apiKey: '' }),
    JSON.stringify(valid).replace('"createdAtMs":0', '"createdAtMs":1e999'),
    JSON.stringify({ ...valid, apiKeyExpiresAtMs: 'later' }),
    JSON.stringify({ ...valid, email: false }),
  ]) {
    await writeFile(path, text)
    await expect(
      readCursorCredentials(selected, limits, new AbortController().signal),
    ).rejects.toThrow()
  }
  await writeFile(path, JSON.stringify(valid))
  const signal = new AbortController()
  race.afterOpen = async () => {
    signal.abort()
  }
  await expect(
    readCursorCredentials(selected, limits, signal.signal),
  ).rejects.toThrow()
})
