import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import { createApp } from '../src/index.js'
import { migrate } from '../src/db/migrate.js'
import { UploadStore } from '../src/uploads/store.js'
import { defaultConfig } from '../src/config.js'

describe('harness settings routes', () => {
  test('tests the mock ACP harness and reports a bad command', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const store = new UploadStore(db, { dataDir: '/tmp/forge-harnesses-test' })
    const config = defaultConfig(true)
    const app = createApp(store, { db, bus: store.eventBus, version: 'test' })

    const listed = await app.request('/api/harnesses')
    expect(listed.status).toBe(200)
    expect(Object.keys(await listed.json())).toContain('mock')

    const good = await app.request('/api/harnesses/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'mock' }),
    })
    expect(good.status).toBe(200)
    expect((await good.json()).ok).toBe(true)

    config.harness.bad = {
      ...config.harness.mock!,
      command: 'sh',
      args: ['-c', 'echo bad-harness >&2; exit 1'],
    }
    // The test route owns its config instance in production. This request pins
    // the error contract through a persisted replacement in the same API.
    await app.request('/api/harnesses', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ harness: config.harness }),
    })
    const bad = await app.request('/api/harnesses/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'bad' }),
    })
    expect(bad.status).toBe(422)
    expect((await bad.json()).ok).toBe(false)
  }, 20_000)
})
