import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createProductionAcpServices,
  createAcpAttachmentResolver,
} from './acp-services.js'
import { createNativeAttachmentLoader } from '../uploads/native.js'
import { UploadStore } from '../uploads/store.js'
import { createAcpAttachments } from '../harnesses/acp/attachments.js'
import { AcpResourceHost } from '../harnesses/acp/limits.js'
import { sdkFixture } from '../harnesses/acp/sdk-test-helpers.js'
import { createCustomAcpAdapter } from '../harnesses/acp/providers.js'
import type { HarnessHandle } from '../harnesses/types.js'
import * as terminalModule from '../harnesses/acp/terminals.js'
import * as filesystemModule from '../harnesses/acp/filesystem.js'
import { WorkspacePath } from '../workspace/paths.js'
import { NativeCleanupError } from '../harnesses/native-cleanup.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const results = await Promise.allSettled(
    cleanups.splice(0).map((close) => close()),
  )
  vi.restoreAllMocks()
  for (const result of results)
    if (result.status === 'rejected') throw result.reason
})
async function uploads() {
  const directory = await mkdtemp('/tmp/forge-acp-services-')
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY, deleted_at INTEGER);
    CREATE TABLE sessions(id TEXT PRIMARY KEY, project_id TEXT, status TEXT DEFAULT 'idle', deleted_at INTEGER);
    INSERT INTO projects VALUES('project',NULL);
    INSERT INTO sessions(id,project_id) VALUES('session','project'),('foreign','project');`)
  const store = new UploadStore(db, { dataDir: directory })
  cleanups.push(async () => {
    store.close()
    db.close()
    await rm(directory, { recursive: true, force: true })
  })
  const upload = store.init('session', {
    filename: 'image.png',
    mime: 'image/png',
    sizeBytes: 5,
  })
  await store.put(upload.attachmentId, new Response('image').body!)
  return {
    db,
    store,
    directory,
    id: upload.attachmentId,
    resolver: createAcpAttachmentResolver(
      createNativeAttachmentLoader(db, directory),
    ),
  }
}

it.each(['filesystem', 'terminal'])(
  'composes original ACP %s callbacks with shared owners',
  async (scenario) => {
    const f = await sdkFixture(scenario)
    let handle: HarnessHandle | undefined
    cleanups.push(() => f.cleanup(handle))
    const terminalStart = vi.spyOn(terminalModule, 'createAcpTerminals')
    const approvedEnv = { FORGE_TOOL_TEST: 'captured' }
    f.deps.services = createProductionAcpServices({
      host: f.deps.host,
      instanceId: 'instance',
      approvedEnv,
    })
    approvedEnv.FORGE_TOOL_TEST = 'changed'
    handle = await createCustomAcpAdapter(f.deps).spawn(f.session, (event) =>
      f.events.push(event),
    )
    expect(terminalStart.mock.calls[0]![0].approvedEnv).toEqual({
      FORGE_TOOL_TEST: 'captured',
    })
    const receipt = await handle.prompt('service')
    expect((await receipt.completion).status).toBe('completed')
    const text = f.events
      .filter((event) => event.type === 'text_delta')
      .map((event) => event.text)
      .join('')
    if (scenario === 'filesystem')
      expect(await readFile(join(f.session.cwd, 'sdk-file.txt'), 'utf8')).toBe(
        text,
      )
    else
      expect(JSON.parse(text)).toMatchObject({
        cwd: f.session.cwd,
        text: 'SDK terminal',
      })
    await handle.kill()
    for (const [kind, amount] of [
      ['filesystem', 8],
      ['terminals', 8],
      ['processes', 8],
      ['descriptors', 256],
    ] as const)
      f.deps.host.reserve('instance', kind, amount)()
    expect(f.failures).toEqual([])
  },
)

it('encodes an authorized upload and rejects foreign ownership and changed bytes', async () => {
  const f = await uploads()
  const host = new AcpResourceHost()
  const attachments = createAcpAttachments({
    host,
    instanceId: 'instance',
    authorizedAttachment: f.resolver,
  })
  cleanups.push(() => attachments.close())
  const controller = new AbortController()
  const prepared = await attachments.prepare(
    'session',
    [{ type: 'attachment', attachmentId: f.id, mime: 'image/png' }],
    { image: true },
    controller.signal,
  )
  expect(prepared.blocks).toEqual([
    {
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from('image').toString('base64'),
    },
  ])
  await prepared.release()
  await expect(
    f.resolver('foreign', f.id, {
      maxBytes: 8 * 1024 * 1024,
      signal: controller.signal,
    }),
  ).rejects.toThrow('unavailable')
  const original = await f.resolver('session', f.id, {
    maxBytes: 8 * 1024 * 1024,
    signal: controller.signal,
  })
  await writeFile(
    join(f.directory, f.store.attachment(f.id)!.rel_path!),
    'other',
  )
  await expect(original.reader.read(6, controller.signal)).rejects.toThrow(
    'changed',
  )
  await expect(original.reader.close()).resolves.toBeUndefined()
})

it('joins a cancelled original attachment read and releases after its ordinary failure', async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const read = vi.fn(async () => {
    await held
    throw Error('original read failed')
  })
  const resolver = createAcpAttachmentResolver(async () => ({
    mime: 'image/png',
    name: 'x',
    path: '/unused',
    sizeBytes: 1,
    sha256: '0'.repeat(64),
    readBytes: read,
    verifyBytes: async () => {},
  }))
  const controller = new AbortController()
  const attachment = await resolver('session', 'attachment', {
    signal: controller.signal,
    maxBytes: 8,
  })
  const work = attachment.reader
    .read(2, controller.signal)
    .catch((error) => error)
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  let settled = false
  const closing = attachment.reader
    .close()
    .catch((error) => error)
    .then((result) => {
      settled = true
      return result
    })
  await Promise.resolve()
  expect(settled).toBe(false)
  release()
  expect(await closing).toBeUndefined()
  expect((await work).message).toBe('original read failed')
})

it.each([false, true])(
  'retains original cleanup when terminal startup fails; terminal cleanup failed=%s',
  async (terminalFailed) => {
    const close = vi
      .fn()
      .mockRejectedValueOnce(Error('close refused'))
      .mockResolvedValue(undefined)
    vi.spyOn(filesystemModule, 'createAcpFilesystem').mockResolvedValue({
      receive: async () => false,
      close,
    })
    const terminalCleanup = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(terminalModule, 'createAcpTerminals').mockRejectedValue(
      terminalFailed
        ? new NativeCleanupError(terminalCleanup)
        : Error('terminal setup failed'),
    )
    const f = await sdkFixture('normal')
    cleanups.push(() => f.cleanup())
    f.deps.services = createProductionAcpServices({
      host: f.deps.host,
      instanceId: 'instance',
      approvedEnv: {},
    })
    const error = await Promise.resolve(
      createCustomAcpAdapter(f.deps).spawn(f.session, () => {}),
    ).catch((error) => error)
    expect(error).toBeInstanceOf(NativeCleanupError)
    await error.retryCleanup()
    expect(close).toHaveBeenCalledTimes(2)
    expect(terminalCleanup).toHaveBeenCalledTimes(terminalFailed ? 1 : 0)
  },
)

it.each(['validation', 'cleanup'] as const)(
  'retains original descriptor cleanup after %s failure',
  async (mode) => {
    const f = await uploads()
    const signal = new AbortController().signal
    const attachment = await f.resolver('session', f.id, {
      signal,
      maxBytes: 8 * 1024 * 1024,
    })
    const originalOpen = WorkspacePath.prototype.openFile
    let closes = 0
    let originalFile: import('node:fs/promises').FileHandle | undefined
    const open = vi
      .spyOn(WorkspacePath.prototype, 'openFile')
      .mockImplementation(function (this: WorkspacePath, onCreated, onClosed) {
        return originalOpen.call(
          this,
          (file) => {
            originalFile = file
            onCreated?.(file)
            const close = file.close.bind(file)
            vi.spyOn(file, 'close').mockImplementation(async () => {
              closes++
              if (closes <= (mode === 'validation' ? 2 : 1))
                throw Error('original descriptor close refused')
              await close()
            })
            if (mode === 'validation')
              vi.spyOn(file, 'stat').mockRejectedValueOnce(
                Error('validation failed'),
              )
          },
          onClosed,
        )
      })
    const error = await attachment.reader
      .read(6, signal)
      .catch((error) => error)
    expect(error).toBeInstanceOf(NativeCleanupError)
    expect(originalFile!.fd).toBeGreaterThanOrEqual(0)
    await attachment.reader.close()
    expect(originalFile!.fd).toBe(-1)
    expect(closes).toBe(mode === 'validation' ? 3 : 2)
    expect(open).toHaveBeenCalledTimes(1)
    await attachment.reader.close()
    expect(closes).toBe(mode === 'validation' ? 3 : 2)
  },
)

it('does not close a descriptor again after early validation cleanup succeeds', async () => {
  const f = await uploads()
  const signal = new AbortController().signal
  const attachment = await f.resolver('session', f.id, {
    signal,
    maxBytes: 8 * 1024 * 1024,
  })
  const originalOpen = WorkspacePath.prototype.openFile
  let close: ReturnType<typeof vi.fn> | undefined
  vi.spyOn(WorkspacePath.prototype, 'openFile').mockImplementation(function (
    this: WorkspacePath,
    onCreated,
    onClosed,
  ) {
    return originalOpen.call(
      this,
      (file) => {
        onCreated?.(file)
        const originalClose = file.close.bind(file)
        close = vi.fn(originalClose)
        file.close = close
        throw Error('capture callback failed')
      },
      onClosed,
    )
  })
  await expect(attachment.reader.read(6, signal)).rejects.toThrow(
    'capture callback failed',
  )
  await attachment.reader.close()
  expect(close).toHaveBeenCalledTimes(1)
})

it('retains the upload metadata owner before exposing an ACP reader', async () => {
  const f = await uploads()
  const host = new AcpResourceHost({ attachments: [1, 1] })
  const helper = createAcpAttachments({
    host,
    instanceId: 'instance',
    authorizedAttachment: f.resolver,
  })
  const originalClose = WorkspacePath.prototype.close
  const owners: WorkspacePath[] = []
  let closes = 0
  vi.spyOn(WorkspacePath.prototype, 'close').mockImplementation(async function (
    this: WorkspacePath,
  ) {
    closes++
    if (!owners.length) {
      owners.push(this)
      throw Error('metadata directory close refused')
    }
    expect(this).toBe(owners[0])
    await originalClose.call(this)
  })
  const signal = new AbortController().signal
  await expect(
    helper.prepare(
      'session',
      [{ type: 'attachment', attachmentId: f.id, mime: 'image/png' }],
      { image: true },
      signal,
    ),
  ).rejects.toBeInstanceOf(NativeCleanupError)
  expect(() => host.reserve('instance', 'attachments')).toThrow(
    'ACP resource limit',
  )
  expect(closes).toBe(1)
  await helper.close()
  expect(closes).toBe(2)
  host.reserve('instance', 'attachments')()
  host.reserve('instance', 'retained', 128 * 1024 * 1024)()
})
