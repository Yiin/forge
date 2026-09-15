import { PassThrough, Writable } from 'node:stream'
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  symlink,
  rename,
  rm,
  readdir,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test, vi, afterEach } from 'vitest'
import { JsonlRpcTransport, type JsonRpcRequest } from '../jsonrpc.js'
import type { AcpLiveOwner } from './ingestion.js'
import { AcpResourceHost } from './limits.js'
import { createAcpFilesystem } from './filesystem.js'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
afterEach(() => vi.useRealTimers())
async function fixture(
  extra: Partial<Parameters<typeof createAcpFilesystem>[0]> = {},
  holdReply = false,
) {
  const root = await mkdtemp(join(tmpdir(), 'forge-acp-fs-'))
  const binding = {
    provider: 'instance',
    accountId: null,
    cwd: root,
    providerSessionId: 'native',
  }
  const owner: AcpLiveOwner = {
    phase: 'live',
    sessionId: 'session',
    providerInstanceId: 'instance',
    account: { kind: 'native-default', configurationId: 'config' },
    runtimeGeneration: extra.runtimeGeneration ?? 'generation',
    runId: 'run',
    turnId: 'turn',
    binding,
  }
  const host = extra.host ?? new AcpResourceHost()
  const stdout = new PassThrough()
  const responses = new Map<
    number,
    ReturnType<typeof deferred<Record<string, unknown>>>
  >()
  const receipts = new Map<number, ReturnType<typeof deferred<boolean>>>()
  const requests = new Map<
    number,
    ReturnType<typeof deferred<JsonRpcRequest>>
  >()
  let held: (() => void) | undefined
  const stdin = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      const frame = JSON.parse(String(chunk))
      responses.get(frame.id)!.resolve(frame)
      if (holdReply) held = callback
      else callback()
    },
  })
  const rpc = new JsonlRpcTransport({
    stdin,
    stdout,
    runtimeGeneration: extra.transportGeneration ?? 'transport-generation',
    maxLineBytes: 16 * 1024 * 1024,
    maxQueuedBytes: 32 * 1024 * 1024,
    onIncoming(message) {
      if (message.type !== 'request') return
      requests.get(Number(message.id))!.resolve(message)
      return helper
        .receive(message, owner)
        .then(
          receipts.get(Number(message.id))!.resolve,
          receipts.get(Number(message.id))!.reject,
        )
    },
  })
  const helper = await createAcpFilesystem({
    session: { id: 'session', provider: 'instance', cwd: root },
    binding: () => binding,
    runtimeGeneration: extra.runtimeGeneration ?? 'generation',
    transportGeneration: extra.transportGeneration ?? 'transport-generation',
    rpc,
    host,
    instanceId: 'instance',
    ...extra,
  })
  let next = 0
  return {
    root,
    helper,
    owner,
    rpc,
    host,
    releaseReply() {
      holdReply = false
      held?.()
      held = undefined
    },
    call(method: string, params: Record<string, unknown>) {
      const id = ++next,
        response = deferred<Record<string, unknown>>(),
        completed = deferred<boolean>(),
        request = deferred<JsonRpcRequest>()
      responses.set(id, response)
      receipts.set(id, completed)
      requests.set(id, request)
      stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method,
          params: { sessionId: 'native', ...params },
        }) + '\n',
      )
      return {
        response: response.promise,
        completed: completed.promise,
        request: request.promise,
      }
    },
    async close() {
      holdReply = false
      held?.()
      await helper.close()
      await rpc.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

describe('ACP workspace filesystem callbacks', () => {
  test('close settles the native request while a held read keeps its original lease', async () => {
    const entered = deferred<void>(),
      held = deferred<void>()
    const host = new AcpResourceHost({ filesystem: [1, 1] })
    const f = await fixture({
      host,
      hooks: {
        beforeRead: async () => {
          entered.resolve()
          await held.promise
        },
      },
    })
    try {
      await writeFile(join(f.root, 'file'), 'content')
      const call = f.call('fs/read_text_file', { path: 'file' })
      await entered.promise
      const closing = f.helper.close()
      expect(await call.response).toHaveProperty('error')
      await call.completed
      expect(() => host.reserve('replacement', 'filesystem')).toThrow(
        'resource limit',
      )
      held.resolve()
      await closing
      host.reserve('replacement', 'filesystem')()
    } finally {
      held.resolve()
      await f.close()
    }
  })
  test('copied request handles cannot start another filesystem operation', async () => {
    const entered = deferred<void>(),
      held = deferred<void>()
    const beforeRead = vi.fn(async () => {
      entered.resolve()
      await held.promise
    })
    const f = await fixture({ hooks: { beforeRead } })
    try {
      await writeFile(join(f.root, 'file'), 'content')
      const call = f.call('fs/read_text_file', { path: 'file' })
      await entered.promise
      await expect(
        f.helper.receive({ ...(await call.request) }, f.owner),
      ).rejects.toThrow('retired')
      expect(beforeRead).toHaveBeenCalledTimes(1)
      held.resolve()
      expect(await call.response).toHaveProperty('result')
      await call.completed
    } finally {
      held.resolve()
      await f.close()
    }
  })
  test('retains a refused leaf close until explicit original-owner cleanup', async () => {
    let close: ReturnType<typeof vi.spyOn> | undefined
    const host = new AcpResourceHost({ filesystem: [1, 1] })
    const f = await fixture({
      host,
      hooks: {
        beforeRead: async (handle) => {
          const original = handle.close.bind(handle)
          close = vi
            .spyOn(handle, 'close')
            .mockRejectedValueOnce(Error('held close'))
            .mockImplementation(original)
        },
      },
    })
    try {
      await writeFile(join(f.root, 'file'), 'content')
      const call = f.call('fs/read_text_file', { path: 'file' })
      expect(await call.response).toHaveProperty('error')
      await call.completed
      expect(() => host.reserve('replacement', 'filesystem')).toThrow(
        'resource limit',
      )
      expect(close).toHaveBeenCalledTimes(1)
      await f.helper.close()
      expect(close).toHaveBeenCalledTimes(2)
      host.reserve('replacement', 'filesystem')()
    } finally {
      await f.close()
    }
  })
  test('rejects a foreign runtime owner before reading', async () => {
    const beforeRead = vi.fn()
    const f = await fixture({ hooks: { beforeRead } })
    try {
      await writeFile(join(f.root, 'file'), 'content')
      Object.assign(f.owner, { runtimeGeneration: 'foreign' })
      const call = f.call('fs/read_text_file', { path: 'file' })
      expect(await call.response).toHaveProperty('error')
      await call.completed
      expect(beforeRead).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  })
  test('writes exact UTF-8 bytes and reads whole text or requested lines', async () => {
    const f = await fixture()
    try {
      const content = '\ufefffirst\r\nsecond\nlast\u0000é'
      const saved = f.call('fs/write_text_file', {
        path: join(f.root, 'file.txt'),
        content,
      })
      expect(await saved.response).toMatchObject({ result: {} })
      await saved.completed
      expect(await readFile(join(f.root, 'file.txt'))).toEqual(
        Buffer.from(content),
      )
      const whole = f.call('fs/read_text_file', { path: 'file.txt' })
      expect(await whole.response).toMatchObject({ result: { content } })
      await whole.completed
      const line = f.call('fs/read_text_file', {
        path: 'file.txt',
        line: 2,
        limit: 1,
      })
      expect(await line.response).toMatchObject({
        result: { content: 'second' },
      })
      await line.completed
      expect(
        (await readdir(f.root)).filter((name) =>
          name.startsWith('.forge-save-'),
        ),
      ).toEqual([])
    } finally {
      await f.close()
    }
  })
  test.each([
    { path: '../outside' },
    { path: '.git/config' },
    { path: '.forge-save-forged' },
    { path: 'file.txt', sessionId: 'foreign' },
    { path: 'file.txt', line: 0 },
    { path: 'file.txt', limit: 0 },
  ])('rejects invalid path, session, or range %j', async (params) => {
    const f = await fixture()
    try {
      await writeFile(join(f.root, 'file.txt'), 'secret')
      const call = f.call('fs/read_text_file', params)
      expect(await call.response).toHaveProperty('error')
      await call.completed
    } finally {
      await f.close()
    }
  })
  test('rejects parent and leaf symlinks for reads and writes', async () => {
    const f = await fixture()
    try {
      await mkdir(join(f.root, 'directory'))
      await writeFile(join(f.root, 'directory', 'source'), 'original')
      await symlink(join(f.root, 'directory'), join(f.root, 'parent'))
      await symlink(join(f.root, 'directory', 'source'), join(f.root, 'leaf'))
      for (const method of ['fs/read_text_file', 'fs/write_text_file']) {
        for (const path of ['parent/source', 'leaf']) {
          const call = f.call(method, { path, content: 'changed' })
          expect(await call.response).toHaveProperty('error')
          await call.completed
        }
      }
      expect(await readFile(join(f.root, 'directory', 'source'), 'utf8')).toBe(
        'original',
      )
    } finally {
      await f.close()
    }
  })
  test('rejects a replaced workspace root', async () => {
    const f = await fixture()
    const moved = `${f.root}-original`
    try {
      await rename(f.root, moved)
      await mkdir(f.root)
      await writeFile(join(f.root, 'file'), 'replacement')
      const call = f.call('fs/read_text_file', { path: 'file' })
      expect(await call.response).toHaveProperty('error')
      await call.completed
    } finally {
      await f.close()
      await rm(moved, { recursive: true, force: true })
    }
  })
  test('accepts the exact content limit and rejects a larger file even for a later line', async () => {
    const f = await fixture()
    try {
      const content = 'x'.repeat(1024 * 1024)
      const write = f.call('fs/write_text_file', { path: 'file', content })
      expect(await write.response).toHaveProperty('result')
      await write.completed
      const read = f.call('fs/read_text_file', { path: 'file' })
      expect(await read.response).toMatchObject({ result: { content } })
      await read.completed
      await writeFile(join(f.root, 'file'), content + '\n')
      const oversized = f.call('fs/read_text_file', {
        path: 'file',
        line: 2,
        limit: 1,
      })
      expect(await oversized.response).toHaveProperty('error')
      await oversized.completed
    } finally {
      await f.close()
    }
  })
  test('retains held read capacity after a logical deadline', async () => {
    const entered = deferred<void>(),
      held = deferred<void>()
    const host = new AcpResourceHost({ filesystem: [1, 1] })
    const f = await fixture({
      host,
      deadlineMs: 20,
      hooks: {
        beforeRead: async () => {
          entered.resolve()
          await held.promise
        },
      },
    })
    vi.useFakeTimers()
    try {
      await writeFile(join(f.root, 'file'), 'content')
      const call = f.call('fs/read_text_file', { path: 'file' })
      await entered.promise
      await vi.advanceTimersByTimeAsync(20)
      expect(await call.response).toHaveProperty('error')
      await call.completed
      expect(() => host.reserve('replacement', 'filesystem')).toThrow(
        'resource limit',
      )
      held.resolve()
      await f.helper.close()
      host.reserve('replacement', 'filesystem')()
    } finally {
      held.resolve()
      await f.close()
    }
  })
  test('holds resource ownership through the original reply callback', async () => {
    const host = new AcpResourceHost({ filesystem: [1, 1] })
    const f = await fixture({ host }, true)
    try {
      await writeFile(join(f.root, 'file'), 'content')
      const call = f.call('fs/read_text_file', { path: 'file' })
      expect(await call.response).toHaveProperty('result')
      expect(() => host.reserve('replacement', 'filesystem')).toThrow(
        'resource limit',
      )
      f.releaseReply()
      await call.completed
      await f.helper.close()
      host.reserve('replacement', 'filesystem')()
    } finally {
      f.releaseReply()
      await f.close()
    }
  })
  test('cancellation before rename removes the owned temporary and preserves the file', async () => {
    const entered = deferred<void>(),
      held = deferred<void>()
    const f = await fixture({
      hooks: {
        beforePublish: async () => {
          entered.resolve()
          await held.promise
        },
      },
    })
    try {
      await writeFile(join(f.root, 'file'), 'original')
      const call = f.call('fs/write_text_file', {
        path: 'file',
        content: 'changed',
      })
      await entered.promise
      f.rpc.dismiss(await call.request)
      held.resolve()
      await call.completed
      await f.helper.close()
      expect(await readFile(join(f.root, 'file'), 'utf8')).toBe('original')
      expect(await readdir(f.root)).toEqual(['file'])
    } finally {
      held.resolve()
      await f.close()
    }
  })
  test('held rename reports publication uncertainty and never rolls back a published file', async () => {
    const entered = deferred<void>(),
      held = deferred<void>()
    const f = await fixture({
      deadlineMs: 20,
      hooks: {
        rename: async (source, destination) => {
          await rename(source, destination)
          entered.resolve()
          await held.promise
        },
      },
    })
    vi.useFakeTimers()
    try {
      await writeFile(join(f.root, 'file'), 'original')
      const call = f.call('fs/write_text_file', {
        path: 'file',
        content: 'changed',
      })
      await entered.promise
      await vi.advanceTimersByTimeAsync(20)
      expect(await call.response).toMatchObject({
        error: { message: 'ACP publication uncertain' },
      })
      await call.completed
      expect(await readFile(join(f.root, 'file'), 'utf8')).toBe('changed')
      held.resolve()
      await f.helper.close()
      expect(await readdir(f.root)).toEqual(['file'])
    } finally {
      held.resolve()
      await f.close()
    }
  })
})

test('eight shallow held reads fit shared resources while a ninth callback is refused', async () => {
  const host = new AcpResourceHost()
  const releaseReads = deferred<void>()
  const entered = Array.from({ length: 8 }, () => deferred<void>())
  const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
  const calls: ReturnType<Awaited<ReturnType<typeof fixture>>['call']>[] = []
  try {
    for (let index = 0; index < 9; index++) {
      fixtures.push(
        await fixture({
          host,
          runtimeGeneration: `generation-${index}`,
          hooks: {
            async beforeRead() {
              entered[index]?.resolve()
              await releaseReads.promise
            },
          },
        }),
      )
      await writeFile(join(fixtures[index]!.root, 'file'), 'small')
    }
    for (let index = 0; index < 8; index++) {
      calls.push(fixtures[index]!.call('fs/read_text_file', { path: 'file' }))
      await entered[index]!.promise
    }
    const blocked = fixtures[8]!.call('fs/read_text_file', { path: 'file' })
    expect(await blocked.response).toHaveProperty('error')
    await blocked.completed
    releaseReads.resolve()
    for (const call of calls) {
      expect(await call.response).toHaveProperty('result.content', 'small')
      await call.completed
    }
  } finally {
    releaseReads.resolve()
    await Promise.all(fixtures.map((value) => value.close()))
  }
})

test('a small read charges its sentinel buffer through physical reply settlement', async () => {
  const host = new AcpResourceHost({ filesystemBytes: [8, 8] })
  const f = await fixture({ host }, true)
  try {
    await writeFile(join(f.root, 'file'), 'small')
    const call = f.call('fs/read_text_file', { path: 'file' })
    expect(await call.response).toHaveProperty('result.content', 'small')
    expect(() => host.reserve('instance', 'filesystemBytes', 3)).toThrow(
      'resource limit',
    )
    f.releaseReply()
    await call.completed
    const release = host.reserve('instance', 'filesystemBytes', 8)
    release()
  } finally {
    await f.close()
  }
})

test('growth after the captured file size fails instead of returning a clipped prefix', async () => {
  const f = await fixture({
    hooks: {
      async beforeRead() {
        await writeFile(join(f.root, 'file'), 'larger content')
      },
    },
  })
  try {
    await writeFile(join(f.root, 'file'), 'small')
    const call = f.call('fs/read_text_file', { path: 'file' })
    expect(await call.response).toHaveProperty('error')
    await call.completed
  } finally {
    await f.close()
  }
})
