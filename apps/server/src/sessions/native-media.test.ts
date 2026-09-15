import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { migrate } from '../db/migrate.js'
import { createSession } from '../db/queries.js'
import { UploadStore } from '../uploads/store.js'
import { NativeStorage } from './native-storage.js'
import { kimiAttachmentIdentity } from './native-factory.js'
import { storeNativeMedia } from './native-media.js'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
async function fixture(provider = 'pi') {
  const dir = await mkdtemp(join(tmpdir(), 'forge-native-media-'))
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const row = createSession(db, {
    harness: provider,
    title: 'media',
    cwd: dir,
    now: 1,
  })
  const uploads = new UploadStore(db, { dataDir: dir })
  const store = new NativeStorage(db, {
    id: row.id,
    provider,
    accountId: null,
    cwd: dir,
  })
  const activation = store.activate(),
    controller = new AbortController()
  cleanups.push(async () => {
    uploads.close()
    db.close()
    await rm(dir, { recursive: true, force: true })
  })
  const text = Buffer.from('native image')
  const input = () => ({
    identity: 'original-image',
    name: 'image.png',
    mime: 'image/png',
    size: text.length,
    sha256: createHash('sha256').update(text).digest('hex'),
    bytes: (async function* () {
      yield text
    })(),
  })
  return { dir, db, uploads, store, activation, controller, input }
}
it('stores provider media without user messages and reuses exact durable identity after activation changes', async () => {
  const f = await fixture()
  const id = await storeNativeMedia(
    f.store,
    f.uploads,
    f.activation,
    f.input(),
    f.controller.signal,
  )
  expect(
    await readFile(join(f.dir, f.uploads.attachment(id)!.rel_path!), 'utf8'),
  ).toBe('native image')
  expect(f.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({
    n: 0,
  })
  const next = f.store.activate()
  expect(
    await storeNativeMedia(
      f.store,
      f.uploads,
      next,
      f.input(),
      f.controller.signal,
    ),
  ).toBe(id)
  await expect(
    storeNativeMedia(
      f.store,
      f.uploads,
      next,
      { ...f.input(), mime: 'other' },
      f.controller.signal,
    ),
  ).rejects.toThrow('identity changed')
  expect(f.db.prepare('SELECT count(*) AS n FROM attachments').get()).toEqual({
    n: 1,
  })
})
it('cleans an artifact when its original activation expires after the physical put', async () => {
  const f = await fixture(),
    original = f.uploads.put.bind(f.uploads)
  vi.spyOn(f.uploads, 'put').mockImplementation(async (...args) => {
    const value = await original(...args)
    f.store.activate()
    return value
  })
  await expect(
    storeNativeMedia(
      f.store,
      f.uploads,
      f.activation,
      f.input(),
      f.controller.signal,
    ),
  ).rejects.toThrow('expired')
  expect(f.db.prepare('SELECT count(*) AS n FROM attachments').get()).toEqual({
    n: 0,
  })
  expect(f.store.pendingMediaCount()).toBe(0)
})
it('retains failed cleanup identity and explicitly retries that original artifact before replacement', async () => {
  const f = await fixture(),
    original = f.uploads.put.bind(f.uploads),
    discard = f.uploads.discardNative.bind(f.uploads)
  vi.spyOn(f.uploads, 'put').mockImplementationOnce(async (...args) => {
    await original(...args)
    throw Error('publication failed')
  })
  const cleanup = vi
    .spyOn(f.uploads, 'discardNative')
    .mockRejectedValueOnce(Error('disk refused'))
  await expect(
    storeNativeMedia(
      f.store,
      f.uploads,
      f.activation,
      f.input(),
      f.controller.signal,
    ),
  ).rejects.toThrow('cleanup failed')
  const old = cleanup.mock.calls[0]![0]
  expect(f.store.pendingMediaCount()).toBe(1)
  cleanup.mockImplementation(discard)
  const id = await storeNativeMedia(
    f.store,
    f.uploads,
    f.activation,
    f.input(),
    f.controller.signal,
  )
  expect(cleanup.mock.calls[1]![0]).toEqual(old)
  expect(id).not.toBe(old.attachmentId)
  expect(f.uploads.attachment(old.attachmentId)).toBeUndefined()
  expect(f.store.pendingMediaCount()).toBe(0)
})
it('holds original work through abort and rejects duplicate physical admission', async () => {
  const f = await fixture()
  let release!: () => void, entered!: () => void
  const held = new Promise<void>((resolve) => {
      release = resolve
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve
    })
  const input = {
    ...f.input(),
    bytes: (async function* () {
      entered()
      await held
      yield Buffer.from('native image')
    })(),
  }
  const work = storeNativeMedia(
    f.store,
    f.uploads,
    f.activation,
    input,
    f.controller.signal,
  )
  const outcome = expect(work).rejects.toThrow()
  await started
  await expect(
    storeNativeMedia(
      f.store,
      f.uploads,
      f.activation,
      f.input(),
      new AbortController().signal,
    ),
  ).rejects.toThrow('still pending')
  f.controller.abort()
  let settled = false
  void work.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await new Promise((resolve) => setImmediate(resolve))
  expect(settled).toBe(false)
  release()
  await outcome
  expect(f.db.prepare('SELECT count(*) AS n FROM attachments').get()).toEqual({
    n: 0,
  })
})

it('rejects completed receipts when the original file disappeared', async () => {
  const f = await fixture()
  const id = await storeNativeMedia(
    f.store,
    f.uploads,
    f.activation,
    f.input(),
    f.controller.signal,
  )
  await rm(join(f.dir, f.uploads.attachment(id)!.rel_path!))
  await expect(
    storeNativeMedia(
      f.store,
      f.uploads,
      f.activation,
      f.input(),
      f.controller.signal,
    ),
  ).rejects.toThrow()
  expect(f.db.prepare('SELECT count(*) AS n FROM attachments').get()).toEqual({
    n: 1,
  })
})

it('rejects a same-size file mutation on completed retry', async () => {
  const f = await fixture()
  const id = await storeNativeMedia(
    f.store,
    f.uploads,
    f.activation,
    f.input(),
    f.controller.signal,
  )
  await writeFile(
    join(f.dir, f.uploads.attachment(id)!.rel_path!),
    'changed data',
  )
  await expect(
    storeNativeMedia(
      f.store,
      f.uploads,
      f.activation,
      f.input(),
      f.controller.signal,
    ),
  ).rejects.toThrow('contents changed')
})

it('verifies a retry above the inline image limit with bounded streaming reads', async () => {
  const f = await fixture(),
    data = Buffer.alloc(11 * 1024 * 1024, 1)
  const input = () => ({
    ...f.input(),
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
    bytes: (async function* () {
      yield data
    })(),
  })
  const id = await storeNativeMedia(
    f.store,
    f.uploads,
    f.activation,
    input(),
    f.controller.signal,
  )
  expect(
    await storeNativeMedia(
      f.store,
      f.uploads,
      f.activation,
      input(),
      f.controller.signal,
    ),
  ).toBe(id)
})

it('reuses Kimi source media across runtime activation and rejects changed bytes for that source', async () => {
  const f = await fixture('kimi')
  const source = {
    scope: {
      sessionId: f.store.session.id,
      runtimeGeneration: 'first',
      binding: {
        provider: 'kimi',
        accountId: null,
        cwd: f.dir,
        providerSessionId: 'native',
      },
    },
    agentId: 'main',
    nativeAttachmentId: 'image',
    sourceIdentity: { domain: 'message' as const, key: 'frame', revision: '1' },
  }
  const first = { ...f.input(), identity: kimiAttachmentIdentity(source) }
  const id = await storeNativeMedia(
    f.store,
    f.uploads,
    f.activation,
    first,
    f.controller.signal,
  )
  const activation = f.store.activate()
  const identity = kimiAttachmentIdentity({
    ...source,
    scope: { ...source.scope, runtimeGeneration: 'second' },
  })
  expect(
    await storeNativeMedia(
      f.store,
      f.uploads,
      activation,
      { ...f.input(), identity },
      f.controller.signal,
    ),
  ).toBe(id)
  const changed = Buffer.from('changed data')
  await expect(
    storeNativeMedia(
      f.store,
      f.uploads,
      activation,
      {
        ...f.input(),
        identity,
        sha256: createHash('sha256').update(changed).digest('hex'),
        bytes: (async function* () {
          yield changed
        })(),
      },
      f.controller.signal,
    ),
  ).rejects.toThrow('identity changed')
})
