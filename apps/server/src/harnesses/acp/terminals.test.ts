import { mkdtemp, rm, writeFile, readFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { expect, test, vi } from 'vitest'
import { NativeProcess, startNativeProcess } from '../process.js'
vi.mock('../process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../process.js')>()
  return { ...actual, startNativeProcess: vi.fn(actual.startNativeProcess) }
})
import { JsonlRpcTransport } from '../jsonrpc.js'
import { deferred } from '../transport-test-helpers.js'
import type { AcpLiveOwner } from './ingestion.js'
import { AcpResourceHost } from './limits.js'
import { createAcpTerminals } from './terminals.js'
import type { PathHooks, WorkspacePath } from '../../workspace/paths.js'

async function fixture(
  options: {
    requestDeadlineMs?: number
    commandDeadlineMs?: number
    hooks?: PathHooks
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'forge-acp-terminal-'))
  const binding = {
    provider: 'provider',
    accountId: null,
    cwd: root,
    providerSessionId: 'native',
  }
  let owner: AcpLiveOwner = {
    sessionId: 'session',
    providerInstanceId: 'provider',
    account: { kind: 'native-default', configurationId: 'profile' },
    runtimeGeneration: 'generation',
    phase: 'live',
    runId: 'run',
    turnId: 'turn',
    binding,
  }
  const input = new PassThrough()
  const requests = new Map<
    number,
    ReturnType<typeof deferred<Record<string, any>>>
  >()
  const handlers = new Map<number, ReturnType<typeof deferred<void>>>()
  let holdReply = false
  const replyHeld = deferred<void>()
  const heldWrites: (() => void)[] = []
  let service!: Awaited<ReturnType<typeof createAcpTerminals>>
  const rpc = new JsonlRpcTransport({
    stdout: input,
    stdin: new Writable({
      write(chunk, _encoding, done) {
        const response = JSON.parse(chunk.toString())
        requests.get(response.id)?.resolve(response)
        if (holdReply) {
          heldWrites.push(done)
          replyHeld.resolve()
        } else done()
      },
    }),
    runtimeGeneration: 'generation',
    async onIncoming(request) {
      if (request.type !== 'request') return
      try {
        await service.receive(request, owner)
        handlers.get(request.id as number)?.resolve()
      } catch (error) {
        handlers
          .get(request.id as number)
          ?.reject(error instanceof Error ? error : Error(String(error)))
      }
    },
  })
  const host = new AcpResourceHost()
  service = await createAcpTerminals({
    session: { id: 'session', provider: 'provider', cwd: root },
    runtimeGeneration: 'generation',
    account: owner.account,
    binding: () => binding,
    rpc,
    host,
    instanceId: 'provider',
    approvedEnv: { PATH: '/usr/bin:/bin', ONLY_APPROVED: 'yes' },
    ...options,
  })
  let id = 0
  async function request(method: string, params: Record<string, unknown>) {
    const key = ++id,
      reply = deferred<Record<string, any>>(),
      handled = deferred<void>()
    requests.set(key, reply)
    handlers.set(key, handled)
    input.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: key,
        method,
        params: { sessionId: 'native', ...params },
      }) + '\n',
    )
    const response = await reply.promise
    await handled.promise
    return response
  }
  return {
    root,
    request,
    host,
    service,
    replyHeld: replyHeld.promise,
    holdReplies() {
      holdReply = true
    },
    releaseReplies() {
      holdReply = false
      heldWrites.splice(0).forEach((done) => done())
    },
    setOwner(value: Partial<AcpLiveOwner>) {
      owner = { ...owner, ...value }
    },
    async close() {
      await service.close()
      await rpc.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}
const child = `const fs=require('node:fs');fs.writeFileSync('ready',JSON.stringify({cwd:process.cwd(),env:process.env}));const timer=setInterval(()=>{if(fs.existsSync('go')){clearInterval(timer);process.stdout.write('hello😀');process.exitCode=0}},5)`
async function ready(root: string) {
  await expect
    .poll(async () => readFile(join(root, 'ready'), 'utf8').catch(() => ''))
    .not.toBe('')
  return JSON.parse(await readFile(join(root, 'ready'), 'utf8'))
}

test('direct native terminal retains output and permits later roots in the same session', async () => {
  const f = await fixture()
  try {
    const created = await f.request('terminal/create', {
      command: process.execPath,
      args: ['-e', child],
      env: [{ name: 'EXPLICIT', value: 'ok' }],
    })
    expect(created.error).toBeUndefined()
    const id = created.result.terminalId
    const observed = await ready(f.root)
    expect(observed.cwd).toBe(f.root)
    expect(observed.env).toEqual({
      PATH: '/usr/bin:/bin',
      ONLY_APPROVED: 'yes',
      EXPLICIT: 'ok',
    })
    f.setOwner({ runId: 'later', turnId: 'later-turn' })
    await writeFile(join(f.root, 'go'), '')
    const finished = await f.request('terminal/wait_for_exit', {
      terminalId: id,
    })
    expect(finished.result.exitCode).toBe(0)
    const output = await f.request('terminal/output', { terminalId: id })
    expect(output.result).toMatchObject({
      output: 'hello😀',
      truncated: false,
      exitStatus: { exitCode: 0 },
    })
    expect(
      (await f.request('terminal/release', { terminalId: id })).result,
    ).toEqual({})
    expect(
      (await f.request('terminal/release', { terminalId: id })).result,
    ).toEqual({})
    expect(
      (await f.request('terminal/kill', { terminalId: id })).result,
    ).toEqual({})
    expect(
      (await f.request('terminal/output', { terminalId: id })).error,
    ).toBeDefined()
  } finally {
    await f.close()
  }
})

test('UTF-8 terminal output keeps a bounded tail with explicit truncation', async () => {
  const f = await fixture()
  try {
    const created = await f.request('terminal/create', {
      command: process.execPath,
      args: ['-e', child],
      outputByteLimit: 5,
    })
    await ready(f.root)
    await writeFile(join(f.root, 'go'), '')
    await f.request('terminal/wait_for_exit', {
      terminalId: created.result.terminalId,
    })
    const output = await f.request('terminal/output', {
      terminalId: created.result.terminalId,
    })
    expect(output.result.output).toBe('o😀')
    expect(output.result.truncated).toBe(true)
  } finally {
    await f.close()
  }
})

test('terminal requests reject foreign native sessions and symlink cwd before spawn', async () => {
  const f = await fixture()
  try {
    await symlink(tmpdir(), join(f.root, 'outside'))
    for (const params of [
      { sessionId: 'foreign' },
      { cwd: 'outside' },
      { cwd: '../' },
    ]) {
      const response = await f.request('terminal/create', {
        command: process.execPath,
        args: ['-e', child],
        ...params,
      })
      expect(response.error).toBeDefined()
    }
    await expect(readFile(join(f.root, 'ready'))).rejects.toThrow()
  } finally {
    await f.close()
  }
})

test('a timed out wait does not cancel the original tool terminal', async () => {
  const f = await fixture({ requestDeadlineMs: 500 })
  try {
    const created = await f.request('terminal/create', {
      command: process.execPath,
      args: ['-e', child],
    })
    await ready(f.root)
    const waiting = await f.request('terminal/wait_for_exit', {
      terminalId: created.result.terminalId,
    })
    expect(waiting.error).toBeDefined()
    await writeFile(join(f.root, 'go'), '')
    expect(
      (
        await f.request('terminal/wait_for_exit', {
          terminalId: created.result.terminalId,
        })
      ).result.exitCode,
    ).toBe(0)
  } finally {
    await f.close()
  }
})

test('completed terminal output remains charged until explicit release', async () => {
  const f = await fixture()
  const ids: string[] = []
  try {
    for (let index = 0; index < 4; index++) {
      const created = await f.request('terminal/create', {
        command: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
      })
      expect(created.error).toBeUndefined()
      ids.push(created.result.terminalId)
      expect(
        (await f.request('terminal/kill', { terminalId: ids.at(-1) })).result,
      ).toEqual({})
    }
    const blocked = await f.request('terminal/create', {
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
    })
    expect(blocked.error).toBeDefined()
    await f.request('terminal/release', { terminalId: ids[0] })
    expect(
      (
        await f.request('terminal/create', {
          command: process.execPath,
          args: ['-e', 'setInterval(()=>{},1000)'],
        })
      ).error,
    ).toBeUndefined()
  } finally {
    await f.close()
  }
})

test('separate account scope cannot access an existing terminal', async () => {
  const f = await fixture()
  try {
    const created = await f.request('terminal/create', {
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
    })
    f.setOwner({
      account: { kind: 'native-default', configurationId: 'other' },
    })
    expect(
      (
        await f.request('terminal/output', {
          terminalId: created.result.terminalId,
        })
      ).error,
    ).toBeDefined()
    expect(
      (await f.request('terminal/create', { command: process.execPath })).error,
    ).toBeDefined()
  } finally {
    await f.close()
  }
})

test('combined output read ceiling stops the original native process', async () => {
  const f = await fixture()
  try {
    const script = `const fs=require('node:fs');fs.writeFileSync('ready',JSON.stringify({pid:process.pid}));const timer=setInterval(()=>{if(fs.existsSync('go')){clearInterval(timer);const chunk=Buffer.alloc(65536,120);function send(){while(process.stdout.write(chunk)){}process.stdout.once('drain',send)}send()}},5)`
    const created = await f.request('terminal/create', {
      command: process.execPath,
      args: ['-e', script],
      outputByteLimit: 8,
    })
    await ready(f.root)
    await writeFile(join(f.root, 'go'), '')
    const result = await f.request('terminal/wait_for_exit', {
      terminalId: created.result.terminalId,
    })
    expect(result.error.message).toBe('ACP terminal read limit')
    const { pid } = JSON.parse(await readFile(join(f.root, 'ready'), 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
    const output = await f.request('terminal/output', {
      terminalId: created.result.terminalId,
    })
    expect(output.error.message).toBe('ACP terminal read limit')
  } finally {
    await f.close()
  }
})

test('refused original process cleanup retains terminal ownership for explicit retry', async () => {
  const f = await fixture()
  const original = NativeProcess.prototype.close
  let rejectCleanup = true
  const close = vi
    .spyOn(NativeProcess.prototype, 'close')
    .mockImplementation(function (this: NativeProcess, reason?: Error) {
      if (rejectCleanup) return Promise.reject(Error('held cleanup refusal'))
      return original.call(this, reason)
    })
  try {
    const created = await f.request('terminal/create', {
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
    })
    expect(created.error).toBeUndefined()
    await expect(f.service.close()).rejects.toThrow('held cleanup refusal')
    expect(() => f.host.reserve('provider', 'terminals', 8)).toThrow(
      'ACP resource limit',
    )
    rejectCleanup = false
    await f.service.close()
    const release = f.host.reserve('provider', 'terminals', 8)
    release()
  } finally {
    rejectCleanup = false
    await f.close()
    close.mockRestore()
  }
})

test('pending physical process cleanup keeps the original terminal lease', async () => {
  const f = await fixture()
  const held = deferred<void>(),
    entered = deferred<void>()
  const original = NativeProcess.prototype.close
  const close = vi
    .spyOn(NativeProcess.prototype, 'close')
    .mockImplementation(async function (this: NativeProcess, reason?: Error) {
      entered.resolve()
      await held.promise
      await original.call(this, reason)
    })
  try {
    expect(
      (
        await f.request('terminal/create', {
          command: process.execPath,
          args: ['-e', 'setInterval(()=>{},1000)'],
        })
      ).error,
    ).toBeUndefined()
    let settled = false
    const pending = f.service.close().then(() => {
      settled = true
    })
    await entered.promise
    expect(settled).toBe(false)
    expect(() => f.host.reserve('provider', 'terminals', 8)).toThrow(
      'ACP resource limit',
    )
    held.resolve()
    await pending
    const release = f.host.reserve('provider', 'terminals', 8)
    release()
  } finally {
    held.resolve()
    await f.close()
    close.mockRestore()
  }
})

test('escape-heavy output replies retain their encoded allocation allowance through the original write', async () => {
  const f = await fixture()
  const reserve = vi.spyOn(f.host, 'reserve')
  try {
    const bytes = 128 * 1024
    const script = child.replace(
      "process.stdout.write('hello😀')",
      `process.stdout.write(Buffer.alloc(${bytes}))`,
    )
    const created = await f.request('terminal/create', {
      command: process.execPath,
      args: ['-e', script],
      outputByteLimit: bytes,
    })
    await ready(f.root)
    await writeFile(join(f.root, 'go'), '')
    await f.request('terminal/wait_for_exit', {
      terminalId: created.result.terminalId,
    })
    reserve.mockClear()
    f.holdReplies()
    const output = f.request('terminal/output', {
      terminalId: created.result.terminalId,
    })
    await f.replyHeld
    expect(reserve).toHaveBeenCalledWith('provider', 'retained', 20 * bytes)
    expect(() =>
      f.host.reserve('provider', 'retained', 124 * 1024 * 1024),
    ).toThrow('ACP resource limit')
    f.releaseReplies()
    expect((await output).result.output).toHaveLength(bytes)
    await f.service.close()
    const released = f.host.reserve('provider', 'retained', 128 * 1024 * 1024)
    released()
  } finally {
    f.releaseReplies()
    await f.close()
    reserve.mockRestore()
  }
})

test('an exit settled before creation publishes cannot install a later command timer', async () => {
  let chain: WorkspacePath | undefined
  const f = await fixture({
    hooks: {
      onCreated(value) {
        chain = value
      },
    },
  })
  const original = (
    await vi.importActual<typeof import('../process.js')>('../process.js')
  ).startNativeProcess
  const start = vi
    .mocked(startNativeProcess)
    .mockImplementation(async (options, initialize) => {
      const result = await original(options, initialize)
      await result.process.done
      await result.process.close()
      await chain!.close()
      await new Promise<void>((resolve) => setImmediate(resolve))
      return result
    })
  const timer = vi.spyOn(globalThis, 'setTimeout')
  try {
    const pending = f.request('terminal/create', {
      command: process.execPath,
      args: ['-e', child],
    })
    await ready(f.root)
    await writeFile(join(f.root, 'go'), '')
    const created = await pending
    expect(created.error).toBeUndefined()
    expect(timer.mock.calls.some((call) => call[1] === 600_000)).toBe(false)
    await f.request('terminal/release', {
      terminalId: created.result.terminalId,
    })
  } finally {
    start.mockImplementation(original)
    timer.mockRestore()
    await f.close()
  }
})
