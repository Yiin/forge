import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CursorStore } from './store.js'
import { CursorResources, cursorLimits, type CursorLimits } from './limits.js'
import { CursorFixtureStore } from '../../../test/fixtures/cursor-store.js'
const roots: string[] = []
afterEach(async () => {
  for (const path of roots.splice(0))
    await rm(path, { recursive: true, force: true })
})
async function fixture(overrides: Partial<CursorLimits> = {}) {
  const path = await mkdtemp(join(tmpdir(), 'forge-cursor-store-'))
  roots.push(path)
  const source = new CursorFixtureStore(path),
    resources = new CursorResources(),
    store = new CursorStore(
      path,
      path,
      source,
      resources,
      cursorLimits(overrides),
      true,
    )
  store.beginAttempt('fixture-attempt')
  const original = {
    agentId: 'agent',
    cwd: path,
    status: 'idle' as const,
    activeRunId: null,
    createdAt: 0,
    updatedAt: 0,
    sdkMetadata: { key: 'must-remain' },
  }
  await store.agents.create({ agent: original })
  await store.runs.create({
    run: {
      agentId: 'agent',
      runId: 'run',
      turnNumber: 1,
      status: 'queued',
      createdAt: 0,
      updatedAt: 0,
    },
  })
  await store.agents.update({ agent: { ...original, activeRunId: 'run' } })
  return { path, source, resources, store, original }
}
async function terminal(store: CursorStore) {
  const run = (await store.runs.get({ agentId: 'agent', runId: 'run' }))!
  await store.runs.update({ run: { ...run, status: 'cancelled', endedAt: 1 } })
  const agent = (await store.agents.get({ agentId: 'agent' }))!
  await store.agents.update({ agent: { ...agent, activeRunId: null } })
}
describe('Cursor wrapper around all source-shaped JSONL surfaces', () => {
  it('exhausts run, event, checkpoint count and checkpoint byte limits before native writes', async () => {
    for (const kind of [
      'runs',
      'runEvents',
      'checkpoints',
      'checkpointBytes',
    ] as const) {
      const { store, source } = await fixture({
        [kind]: kind === 'checkpointBytes' ? 4 : 1,
      })
      let operation: () => Promise<unknown>
      if (kind === 'runs') {
        await terminal(store)
        store.endAttempt()
        store.beginAttempt('next')
        operation = () =>
          store.runs.create({
            run: {
              agentId: 'agent',
              runId: 'next',
              turnNumber: 2,
              status: 'queued',
              createdAt: 1,
              updatedAt: 1,
            },
          })
      } else if (kind === 'runEvents') {
        await store.runEvents.append({
          runId: 'run',
          eventType: 'fixture',
          payload: null,
        })
        operation = () =>
          store.runEvents.append({
            runId: 'run',
            eventType: 'fixture',
            payload: null,
          })
      } else {
        if (kind === 'checkpoints') {
          const data = Buffer.from('one')
          await store.checkpoints.create({
            agentId: 'agent',
            blobId: createHash('sha256').update(data).digest('hex'),
            data,
          })
        }
        const data = Buffer.from('second')
        operation = () =>
          store.checkpoints.create({
            agentId: 'agent',
            blobId: createHash('sha256').update(data).digest('hex'),
            data,
          })
      }
      const writes = source.writes.length
      await expect(operation()).rejects.toThrow()
      expect(source.writes.length).toBe(writes)
    }
  })
  it('holds an active store write at its local operation ceiling and rejects global input exhaustion', async () => {
    const { store, source, resources } = await fixture({ storeOperations: 1 })
    const run = (await store.runs.get({ agentId: 'agent', runId: 'run' }))!
    let release!: () => void,
      entered = false
    const gate = new Promise<void>((done) => {
      release = done
    })
    source.beforeWrite = async () => {
      entered = true
      await gate
    }
    const write = store.runs.update({
      run: { ...run, status: 'running', startedAt: 1 },
    })
    try {
      await vi.waitFor(() => expect(entered).toBe(true))
      await expect(
        store.runs.get({ agentId: 'agent', runId: 'run' }),
      ).rejects.toThrow('queue_limit')
      expect(resources.snapshot().storeOperations).toBe(1)
    } finally {
      release()
      await write
    }
    expect(resources.snapshot().storeOperations).toBe(0)
    const another = await fixture(),
      charged = another.resources.charge(
        'storeInputBytes',
        cursorLimits().globalStoreInputBytes,
        cursorLimits().globalStoreInputBytes,
      ),
      writes = another.source.writes.length
    try {
      await expect(
        another.store.agents.get({ agentId: 'agent' }),
      ).rejects.toThrow('resource_limit')
      expect(another.source.writes.length).toBe(writes)
    } finally {
      charged()
    }
  })
  it('carries enumerable revisions and rejects stale cancellation/checkpoint writes before mutation', async () => {
    const { store, source } = await fixture(),
      stale = (await store.runs.get({ agentId: 'agent', runId: 'run' }))!
    const symbol = Object.getOwnPropertySymbols(stale)[0]
    expect(Object.getOwnPropertyDescriptor(stale, symbol)?.enumerable).toBe(
      true,
    )
    await terminal(store)
    const writes = source.writes.length
    await expect(
      store.runs.update({ run: { ...stale, status: 'running' } }),
    ).rejects.toThrow('revision_conflict')
    await expect(store.runs.delete({ filter: {} })).rejects.toThrow(
      'revision_conflict',
    )
    expect(source.writes.length).toBe(writes)
    expect(
      (await store.runs.get({ agentId: 'agent', runId: 'run' }))?.status,
    ).toBe('cancelled')
    await expect(store.drain()).rejects.toThrow('revision_conflict')
  })
  it('rejects untagged or foreign full rows after the single original creation exception', async () => {
    for (const foreign of [false, true]) {
      const { store, source, original } = await fixture()
      let agent: any = { ...original, activeRunId: 'run' }
      if (foreign) {
        const other = await fixture()
        agent = {
          ...(await other.store.agents.get({ agentId: 'agent' }))!,
          cwd: store.cwd,
        }
      }
      const before = source.writes.length
      await expect(store.agents.update({ agent })).rejects.toThrow(
        'revision_conflict',
      )
      expect(source.writes.length).toBe(before)
    }
  })
  it('preserves checkpoint hashes and covers create/get/update/list/delete plus both event deletion paths', async () => {
    const { store, source } = await fixture(),
      data = Buffer.from('checkpoint'),
      blobId = createHash('sha256').update(data).digest('hex')
    await store.checkpoints.create({ agentId: 'agent', blobId, data })
    expect(await store.checkpoints.get({ agentId: 'agent', blobId })).toEqual(
      data,
    )
    await store.checkpoints.update({ agentId: 'agent', blobId, data })
    expect((await store.checkpoints.list()).items).toEqual([blobId])
    await store.runEvents.append({
      runId: 'run',
      eventType: 'test',
      payload: { text: 'one' },
      idempotencyKey: 'id',
    })
    await store.runEvents.append({
      runId: 'run',
      eventType: 'test',
      payload: { text: 'duplicate' },
      idempotencyKey: 'id',
    })
    expect((await store.runEvents.list({ runId: 'run' })).items).toHaveLength(1)
    await terminal(store)
    await store.runEvents.delete({ filter: { runIds: ['run'] } })
    await store.runEvents.append({ runId: 'run', eventType: 'tail' })
    await store.runs.delete({ filter: { runIds: ['run'] } })
    expect((await store.runEvents.list({ runId: 'run' })).items).toHaveLength(0)
    expect(source.writes.slice(-2)).toEqual(['runs', 'runEvents'])
    await store.checkpoints.delete({ filter: { blobIds: [blobId] } })
    await store.agents.delete({ filter: { agentIds: ['agent'] } })
    expect((await store.agents.list()).items).toHaveLength(0)
    await store.drain()
  })
  it('retains physical input charges through cancellation and latches swallowed write failures', async () => {
    const { store, source, resources } = await fixture()
    let release!: () => void,
      entered = false
    source.beforeWrite = async () => {
      entered = true
      await new Promise<void>((resolve) => {
        release = resolve
      })
      throw new Error('fixture write failed')
    }
    const row = (await store.runs.get({ agentId: 'agent', runId: 'run' }))!,
      writing = store.runs.update({ run: { ...row, status: 'running' } })
    void writing.catch(() => {})
    await vi.waitFor(() => expect(entered).toBe(true))
    store.revoke()
    expect(resources.snapshot().storeOperations).toBe(1)
    expect(resources.snapshot().storeInputBytes).toBeGreaterThan(0)
    release()
    await expect(writing).rejects.toThrow('fixture write failed')
    expect(resources.snapshot().storeOperations).toBe(0)
    expect(
      resources.snapshot()[`storeTemporary:${store.directory}`],
    ).toBeGreaterThan(0)
    await expect(store.drain()).rejects.toThrow('fixture write failed')
  })
  it('rejects corruption and reentrant inputs without an underlying rewrite', async () => {
    const { store, source, path } = await fixture()
    let reads = 0
    await expect(
      store.agents.update({
        get agent() {
          reads++
          return {} as any
        },
      }),
    ).rejects.toThrow('accessor')
    expect(reads).toBe(0)
    const count = source.writes.length
    await writeFile(join(path, 'runs.ndjson'), '{"corrupt":')
    await expect(
      store.runs.get({ agentId: 'agent', runId: 'run' }),
    ).rejects.toThrow()
    expect(source.writes.length).toBe(count)
  })
  it('reserves exact committed plus temporary bytes before a rewrite', async () => {
    const { store, path, source } = await fixture(),
      inventory = await store.drain(),
      limits = cursorLimits({
        fileBytes: inventory.total + 10,
        committedBytes: inventory.total + 10,
        physicalStoreBytes: inventory.total + 10,
      })
    const wrapped = new CursorStore(
        path,
        path,
        source,
        new CursorResources(),
        limits,
        false,
      ),
      run = (await wrapped.runs.get({ agentId: 'agent', runId: 'run' }))!,
      before = await readFile(join(path, 'runs.ndjson'), 'utf8')
    await expect(
      wrapped.runs.update({ run: { ...run, status: 'running' } }),
    ).rejects.toThrow('temporary_limit')
    expect(await readFile(join(path, 'runs.ndjson'), 'utf8')).toBe(before)
  })
})
