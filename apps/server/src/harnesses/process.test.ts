import { pbkdf2 } from 'node:crypto'
import * as processGroups from './process-group.js'
import { getEventListeners, once } from 'node:events'
import {
  groupHasRunningMember,
  statIsRunningGroupMember,
  waitForProcessGroupExit,
} from './process-group.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JsonlTransport } from './jsonl.js'
import { JsonlRpcTransport } from './jsonrpc.js'
import { DiagnosticTail, diagnosticError } from './diagnostics.js'
import {
  startNativeProcess,
  type NativeProcess,
  type NativeProcessOptions,
} from './process.js'
import {
  bytePayload,
  deferred,
  expectStopped,
  fixture,
  running,
  startFixture,
} from './transport-test-helpers.js'

const cleanupSpies: Array<{ mockRestore(): void }> = []
beforeEach(() => {
  const originalWait = processGroups.waitForProcessGroupExit
  cleanupSpies.push(
    vi
      .spyOn(processGroups, 'waitForProcessGroupExit')
      .mockImplementation(async (...args) => {
        try {
          return await originalWait(...args)
        } catch (error) {
          const cause = error as NodeJS.ErrnoException
          console.error('FORGE_PROCESS_CLEANUP_DIAGNOSTIC', {
            operation: 'waitForProcessGroupExit',
            name: cause.name,
            code: cause.code,
            syscall: cause.syscall,
            message: cause.message,
            remainingMs: args[1] - performance.now(),
          })
          throw error
        }
      }),
  )
  const originalSignal = processGroups.signalProcessGroup
  cleanupSpies.push(
    vi
      .spyOn(processGroups, 'signalProcessGroup')
      .mockImplementation((...args) => {
        try {
          return originalSignal(...args)
        } catch (error) {
          const cause = error as NodeJS.ErrnoException
          console.error('FORGE_PROCESS_CLEANUP_DIAGNOSTIC', {
            operation: 'signalProcessGroup',
            name: cause.name,
            code: cause.code,
            syscall: cause.syscall,
            message: cause.message,
          })
          throw error
        }
      }),
  )
})
afterEach(() => {
  for (const spy of cleanupSpies.splice(0)) spy.mockRestore()
})

async function readyProcess(
  mode: string,
  options: Partial<NativeProcessOptions> = {},
) {
  const ready = deferred<{ pid: number; descendant?: number }>()
  return startFixture(
    mode,
    async (runtime) => {
      const wire = new JsonlTransport({
        stdin: runtime.child.stdin,
        stdout: runtime.child.stdout,
        onValue: (value) =>
          ready.resolve(value as { pid: number; descendant?: number }),
      })
      runtime.ownTransport(wire)
      return { wire, ready: await ready.promise }
    },
    options,
  )
}

function attachRpc(runtime: NativeProcess, secrets: string[] = []) {
  const transport = new JsonlRpcTransport({
    stdin: runtime.child.stdin,
    stdout: runtime.child.stdout,
    runtimeGeneration: 'process-test',
    secrets,
  })
  runtime.ownTransport(transport)
  return transport
}

describe('native startup and ownership', () => {
  it('inherits the account environment and uses the effective cwd', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-native-cwd-'))
    const accountHome = join(cwd, 'account-home')
    vi.stubEnv('FORGE_TEST_INHERITED', 'inherited-value')
    try {
      const { process: runtime, value } = await startFixture(
        'rpc',
        async (runtime) => attachRpc(runtime).request('env'),
        { cwd, env: { CODEX_HOME: accountHome } },
      )
      expect(value).toMatchObject({
        cwd,
        home: accountHome,
        inherited: 'inherited-value',
        pid: runtime.child.pid,
      })
      await runtime.close()
    } finally {
      vi.unstubAllEnvs()
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('rejects pre-aborted startup before spawning or calling initialize', async () => {
    const controller = new AbortController()
    controller.abort(new Error('raw-secret'))
    const initialize = vi.fn()
    await expect(
      startNativeProcess(
        { command: process.execPath, signal: controller.signal },
        initialize,
      ),
    ).rejects.toThrow('startup cancelled')
    expect(initialize).not.toHaveBeenCalled()
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it.each([
    { command: '/missing-forge-native-executable' },
    { cwd: '/missing-forge-native-directory' },
    { command: '' },
    { command: 'invalid\0command' },
  ])('cleans up spawn failure %j', async (options) => {
    const controller = new AbortController()
    const initialize = vi.fn(async () => undefined)
    await expect(
      startFixture('rpc', initialize, {
        ...options,
        signal: controller.signal,
      }),
    ).rejects.toThrow('failed to spawn')
    expect(initialize).not.toHaveBeenCalled()
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('uses an absolute deadline despite continuous valid startup output', async () => {
    let runtime!: NativeProcess
    let frames = 0
    const started = performance.now()
    await expect(
      startFixture(
        'noisy',
        async (child) => {
          runtime = child
          const wire = new JsonlTransport({
            stdin: child.child.stdin,
            stdout: child.child.stdout,
            onValue: () => {
              frames++
            },
          })
          child.ownTransport(wire)
          return new Promise<void>(() => {})
        },
        { startupTimeoutMs: 150 },
      ),
    ).rejects.toThrow('startup timed out')
    expect(frames).toBeGreaterThan(5)
    expect(performance.now() - started).toBeLessThan(1500)
    await expectStopped(runtime.child.pid!)
    expect(runtime.signal.aborted).toBe(true)
  })

  it('rejects initialization that finishes after its absolute deadline', async () => {
    let runtime!: NativeProcess
    await expect(
      startFixture(
        'rpc',
        async (child) => {
          runtime = child
          const until = performance.now() + 50
          while (performance.now() < until) {
            /* Hold the event loop beyond the deadline. */
          }
          return true
        },
        { startupTimeoutMs: 20 },
      ),
    ).rejects.toThrow('startup timed out')
    await expectStopped(runtime.child.pid!)
  })

  it('rejects initialization after the child exit event while its descendant holds output open', async () => {
    let runtime!: NativeProcess
    let descendant!: number
    await expect(
      startFixture('tree', async (child) => {
        runtime = child
        const ready = deferred<{ descendant: number }>()
        const wire = new JsonlTransport({
          stdin: child.child.stdin,
          stdout: child.child.stdout,
          onValue: (value) => ready.resolve(value as { descendant: number }),
        })
        child.ownTransport(wire)
        descendant = (await ready.promise).descendant
        const exited = once(child.child, 'exit')
        child.child.stdin.write('exit\n')
        await exited
        expect(child.child.exitCode).toBe(0)
        expect(child.signal.aborted).toBe(false)
        return { ready: true }
      }),
    ).rejects.toThrow('Native process exited')
    await expectStopped(runtime.child.pid!)
    await expectStopped(descendant)
  })

  it('cancels pending startup and runtime work and removes external listeners', async () => {
    let runtime!: NativeProcess
    const initialized = deferred<void>()
    const controller = new AbortController()
    const start = startFixture(
      'rpc',
      async (child) => {
        runtime = child
        const transport = attachRpc(child)
        initialized.resolve()
        return transport.request('pending')
      },
      { signal: controller.signal },
    ).catch((error: Error) => error)
    await initialized.promise
    controller.abort()
    expect(((await start) as Error).message).toContain('cancelled')
    await expectStopped(runtime.child.pid!)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    expect(runtime.child.listenerCount('error')).toBe(0)
    expect(runtime.child.stdout.listenerCount('error')).toBe(0)
    expect(runtime.child.stdin.listenerCount('error')).toBe(0)
  })

  it('cancels a live runtime after startup has finished', async () => {
    const controller = new AbortController()
    const { process: runtime, value: transport } = await startFixture(
      'rpc',
      async (child) => attachRpc(child),
      { signal: controller.signal },
    )
    const pending = transport
      .request('pending')
      .catch((error: Error) => error.message)
    controller.abort()
    expect(await pending).toContain('cancelled')
    await runtime.done
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    await expectStopped(runtime.child.pid!)
  })

  it('preserves rejected resume, redacts its reason, and never starts a fresh session', async () => {
    let runtime!: NativeProcess
    const methods: string[] = []
    const secret = 'fixture-token-🔑-123'
    await expect(
      startFixture(
        'rpc',
        async (child) => {
          runtime = child
          const transport = attachRpc(child, [secret])
          const write = child.child.stdin.write.bind(child.child.stdin)
          vi.spyOn(child.child.stdin, 'write').mockImplementation(
            (...args: Parameters<typeof write>) => {
              methods.push(
                (JSON.parse(String(args[0])) as { method: string }).method,
              )
              return write(...args)
            },
          )
          return transport.request('resume', { sessionId: 'missing-session' })
        },
        { env: { FORGE_TEST_SECRET: secret }, secrets: [secret] },
      ),
    ).rejects.toThrow('Resume rejected: [REDACTED] (code -32001)')
    expect(methods).toEqual(['resume'])
    await expectStopped(runtime.child.pid!)
    expect((await runtime.done).message).not.toContain(secret)
    expect((await runtime.done).message).not.toContain(
      'never expose this payload',
    )
  })

  it('cleans up rejected initialization and deadline timers', async () => {
    let runtime!: NativeProcess
    const set = vi.spyOn(globalThis, 'setTimeout')
    const clear = vi.spyOn(globalThis, 'clearTimeout')
    try {
      await expect(
        startFixture('rpc', async (child) => {
          runtime = child
          throw new Error('Initialize rejected')
        }),
      ).rejects.toThrow('Initialize rejected')
      expect(clear).toHaveBeenCalledWith(set.mock.results[0]!.value)
      await expectStopped(runtime.child.pid!)
    } finally {
      set.mockRestore()
      clear.mockRestore()
    }
  })

  it('stops a child that closes stdout while remaining alive', async () => {
    const { process: runtime } = await startFixture(
      'bytes',
      async (runtime) => {
        const wire = new JsonlTransport({
          stdin: runtime.child.stdin,
          stdout: runtime.child.stdout,
          onValue: () => {},
        })
        runtime.ownTransport(wire)
        return wire
      },
      {},
      bytePayload([]),
    )
    expect((await runtime.done).message).toContain('stdout ended')
    await expectStopped(runtime.child.pid!)
  })

  it('stops its group on a reader failure with safe error output', async () => {
    const { process: runtime } = await readyProcess('ignore-term')
    runtime.child.stdout.destroy(new Error('synthetic-raw-payload'))
    const reason = await runtime.done
    expect(reason.message).toContain('read failed')
    expect(reason.message).not.toContain('synthetic-raw-payload')
    await expectStopped(runtime.child.pid!)
  })

  it('escalates to KILL when TERM does not stop the owned child', async () => {
    const { process: runtime } = await readyProcess('ignore-term')
    await runtime.close()
    expect(runtime.child.signalCode).toBe('SIGKILL')
    await expectStopped(runtime.child.pid!)
  })

  it.each([false, true])(
    'stops descendants that ignore TERM, including after parent exit: %s',
    async (exitParent) => {
      const sentinel = await readyProcess('ignore-term')
      const tree = await readyProcess('tree')
      const descendant = tree.value.ready.descendant!
      try {
        expect(await running(descendant)).toBe(true)
        if (exitParent) {
          tree.process.child.stdin.write('exit\n')
          await tree.process.done
        } else await tree.process.close()
        await expectStopped(tree.process.child.pid!)
        await expectStopped(descendant)
        expect(await running(sentinel.process.child.pid!)).toBe(true)
        await tree.process.close()
        expect(await running(sentinel.process.child.pid!)).toBe(true)
      } finally {
        await tree.process.close()
        // Test cleanup also covers assertions that fail before the supervised close.
        if (await running(descendant)) process.kill(descendant, 'SIGKILL')
        await sentinel.process.close()
      }
    },
  )

  it('waits for an orphaned running descendant and permits its zombie after KILL', async () => {
    const tree = await readyProcess('tree')
    const group = tree.process.child.pid!
    const descendant = tree.value.ready.descendant!
    try {
      expect(await groupHasRunningMember(group, performance.now() + 1000)).toBe(
        true,
      )
      const exited = once(tree.process.child, 'exit')
      tree.process.child.stdin.write('exit\n')
      await exited
      await tree.process.done
      expect(await running(descendant)).toBe(false)
      expect(await groupHasRunningMember(group, performance.now() + 1000)).toBe(
        false,
      )
    } finally {
      await tree.process.close()
      if (await running(descendant)) process.kill(descendant, 'SIGKILL')
    }
  })

  it('bounds final inspection while an owned group still has a running member', async () => {
    const { process: runtime } = await readyProcess('ignore-term')
    await expect(
      waitForProcessGroupExit(runtime.child.pid!, performance.now() + 20),
    ).rejects.toThrow('cleanup timed out')
    expect(await running(runtime.child.pid!)).toBe(true)
    await runtime.close()
  })

  it('bounds owned group cleanup while filesystem work waits behind crypto jobs', async () => {
    const ready = deferred<{ descendant: number }>()
    const { process: runtime, value } = await startNativeProcess(
      {
        command: process.execPath,
        args: [fixture, 'tree'],
        killGraceMs: 20,
        cleanupTimeoutMs: 40,
      },
      async (child) => {
        child.ownTransport(
          new JsonlTransport({
            stdin: child.child.stdin,
            stdout: child.child.stdout,
            onValue: (value) => ready.resolve(value as { descendant: number }),
          }),
        )
        return ready.promise
      },
    )
    let completed = 0
    const jobs = Array.from(
      { length: Number(process.env.UV_THREADPOOL_SIZE ?? 4) },
      () =>
        new Promise<void>((resolve, reject) => {
          pbkdf2(
            'owned-fixture',
            'local-salt',
            5_000_000,
            32,
            'sha256',
            (error) => {
              completed++
              if (error) reject(error)
              else resolve()
            },
          )
        }),
    )
    let timerFired = false
    const responsive = delay(10).then(() => {
      timerFired = true
    })
    const kill = vi.spyOn(process, 'kill')
    try {
      const reason = await runtime.close().then(
        () => 'closed',
        (error: Error) => error.message,
      )
      expect(reason).toContain('cleanup failed')
      expect(timerFired).toBe(true)
      expect(completed).toBe(0)
      const signals = kill.mock.calls.slice()
      await Promise.all(jobs)
      await delay(0)
      expect(kill.mock.calls).toEqual(signals)
      expect(await running(runtime.child.pid!)).toBe(false)
      expect(await running(value.descendant)).toBe(false)
    } finally {
      kill.mockRestore()
      await Promise.all(jobs)
      await responsive
      await runtime.close().catch(() => {})
      if (await running(value.descendant))
        process.kill(value.descendant, 'SIGKILL')
    }
  })

  it('distinguishes zombies, dead members, stopped members, and other groups', () => {
    expect(
      statIsRunningGroupMember('123 (name with ) spaces) Z 1 50 0', 50),
    ).toBe(false)
    expect(statIsRunningGroupMember('123 (child) X 1 50 0', 50)).toBe(false)
    expect(statIsRunningGroupMember('123 (child) R 1 50 0', 50)).toBe(true)
    expect(statIsRunningGroupMember('123 (child) T 1 50 0', 50)).toBe(true)
    expect(statIsRunningGroupMember('123 (sentinel) S 1 51 0', 50)).toBe(false)
  })

  it('leaves no delayed group signals after close returns', async () => {
    const { process: runtime } = await readyProcess('ignore-term')
    const kill = vi.spyOn(process, 'kill')
    try {
      await runtime.close()
      const calls = kill.mock.calls.length
      const signals = kill.mock.calls.filter(
        ([pid, signal]) => pid === -runtime.child.pid! && signal !== 0,
      )
      expect(signals.map(([, signal]) => signal)).toEqual([
        'SIGTERM',
        'SIGKILL',
      ])
      await delay(60)
      expect(kill.mock.calls).toHaveLength(calls)
    } finally {
      kill.mockRestore()
    }
  })

  it('shares one close operation even when an abort handler calls close again', async () => {
    const { process: runtime } = await readyProcess('ignore-term')
    let reentrant: Promise<void> | undefined
    runtime.signal.addEventListener(
      'abort',
      () => {
        reentrant = runtime.close()
      },
      { once: true },
    )
    const first = runtime.close()
    expect(reentrant).toBe(first)
    expect(runtime.close()).toBe(first)
    await first
    await delay(60)
    expect(runtime.child.listenerCount('exit')).toBe(0)
  })
})

describe('native diagnostics', () => {
  it('redacts split secrets before byte truncation, without waiting for a newline', async () => {
    const secret = 'token-🔑-sensitive'
    const encoded = Buffer.from(secret)
    const split = encoded.indexOf(Buffer.from('🔑')) + 2
    const chunks = [
      Buffer.from('😀'.repeat(1000)),
      encoded.subarray(0, split),
      encoded.subarray(split),
      Buffer.from(' final'),
    ]
    const ready = deferred<void>()
    const { process: runtime } = await startFixture(
      'stderr',
      async (runtime) => {
        const wire = new JsonlTransport({
          stdin: runtime.child.stdin,
          stdout: runtime.child.stdout,
          onValue: () => ready.resolve(),
        })
        runtime.ownTransport(wire)
        await ready.promise
      },
      { secrets: [secret], stderrLimit: 32 },
      JSON.stringify(chunks.map((chunk) => chunk.toString('base64'))),
    )
    expect(runtime.diagnostics).toContain('[REDACTED] final')
    expect(runtime.diagnostics).not.toContain('sensitive')
    expect(Buffer.byteLength(runtime.diagnostics)).toBeLessThanOrEqual(32)
    await runtime.close()
    expect(Buffer.byteLength(runtime.diagnostics)).toBeLessThanOrEqual(32)
  })

  it.each(['-sensitive', '-sensitive-extra'])(
    'holds overlapping secrets until the longest match is known: %s',
    (suffix) => {
      const tail = new DiagnosticTail(64, [
        'token',
        'token-sensitive',
        'token-sensitive-extra',
      ])
      tail.append(Buffer.from('prefix token'))
      expect(tail.text).toBe('prefix ')
      tail.append(Buffer.from(suffix))
      tail.append(Buffer.from('!'))
      tail.finish()
      expect(tail.text).toBe('prefix [REDACTED]!')
      expect(diagnosticError(new Error(tail.text)).message).toBe(
        'prefix [REDACTED]!',
      )
    },
  )

  it.each(['token', 'token-sens', 'token!'])(
    'finishes an ambiguous secret prefix safely: %s',
    (value) => {
      const tail = new DiagnosticTail(64, ['token', 'token-sensitive'])
      tail.append(Buffer.from(value))
      if (value !== 'token!') expect(tail.text).toBe('')
      tail.finish()
      expect(tail.text).toBe(value.endsWith('!') ? '[REDACTED]!' : '[REDACTED]')
    },
  )

  it('keeps incomplete secret prefixes out of snapshots and handles a secret larger than the tail', () => {
    const secret = 'very-long-synthetic-secret'
    const tail = new DiagnosticTail(12, [secret])
    tail.append(Buffer.from('message ' + secret.slice(0, 12)))
    expect(tail.text).toBe('message ')
    tail.append(Buffer.from(secret.slice(12)))
    tail.finish()
    expect(tail.text).toContain('[REDACTED]')
    expect(Buffer.byteLength(tail.text)).toBeLessThanOrEqual(12)
    const partial = new DiagnosticTail(20, [secret])
    partial.append(Buffer.from(secret.slice(0, 10)))
    partial.finish()
    expect(partial.text).toBe('[REDACTED]')
  })

  it('keeps errors byte bounded and excludes error causes and structured data', () => {
    const error = diagnosticError(
      new Error('😀'.repeat(5000) + ' secret', {
        cause: { token: 'secret' },
      }),
      ['secret'],
      32,
    )
    expect(Buffer.byteLength(error.message)).toBeLessThanOrEqual(32)
    expect(error.message).not.toContain('secret')
    expect(error.cause).toBeUndefined()
  })
})

it.each([false, true])(
  'captures original startup ownership when the creation hook throws, missing executable: %s',
  async (missing) => {
    let captured: NativeProcess | undefined
    const initialize = vi.fn(async () => {})
    await expect(
      startNativeProcess(
        {
          command: missing
            ? '/nonexistent/forge-on-created-fixture'
            : process.execPath,
          args: missing ? [] : ['-e', 'setInterval(() => {}, 1000)'],
          onCreated(runtime) {
            captured = runtime
            throw Error('creation hook failed')
          },
        },
        initialize,
      ),
    ).rejects.toThrow('creation hook failed')
    expect(captured).toBeDefined()
    expect(initialize).not.toHaveBeenCalled()
    await captured!.close()
    if (captured!.child.pid !== undefined)
      await expectStopped(captured!.child.pid)
  },
)
