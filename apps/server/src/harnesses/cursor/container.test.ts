import { mkdtemp, lstat, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { expect, it, vi } from 'vitest'
import { CursorContainer, processIdentity } from './container.js'
import { createCursorResources, cursorLimits } from './limits.js'
import { writeMarker } from './store.js'
import type { CursorLaunch } from './launch.js'
import type { CursorOwner } from './contracts.js'
import { NativeProcess } from '../process.js'
import * as processGroups from '../process-group.js'
import type { CursorWire } from './wire.js'
import { CursorError } from './limits.js'

it('closes the exact direct process after refused retirement and retries direct cleanup after a settled rejection', async () => {
  for (const rejectDirect of [false, true]) {
    const root = await mkdtemp('/tmp/forge-cursor-close-correction-'),
      limits = cursorLimits(),
      resources = createCursorResources()
    const owner: CursorOwner = {
      forgeSessionId: 'session',
      provider: 'cursor',
      accountId: 'account',
      cwd: root,
      storeId: randomUUID(),
      generation: randomUUID(),
      attemptId: 'attempt',
      runId: 'run',
      turnId: 'turn',
    }
    const container = new CursorContainer(
      {} as CursorLaunch,
      owner,
      join(root, 'sdk'),
      resources,
      limits,
      () => {},
    )
    container.identity = {
      unit: `forge-cursor-${randomUUID()}.service`,
      nonce: randomUUID(),
      generation: owner.generation,
      leaseId: randomUUID(),
      boot: 'synthetic-service',
      host: 'synthetic-service',
    }
    const fence = join(root, 'writer-fence.json'),
      release = resources.reserveContainer(fence, limits)
    ;(container as any).release = release
    let original: Awaited<ReturnType<typeof processIdentity>> | undefined
    const prefix = `/var/tmp/forge-comet-cursor-review-correction-v2-direct-${owner.generation}`
    const child = (
      await NativeProcess.start(
        {
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          cwd: root,
        },
        async (child) => {
          original = await processIdentity(child.child.pid!)
          await writeFile(
            `${prefix}-start.json`,
            JSON.stringify({
              root,
              owner,
              controller: await processIdentity(process.pid),
              original,
              scenario: { rejectDirect },
              service: 'synthetic refusal only',
            }),
            { flag: 'wx' },
          )
        },
      )
    ).process
    container.process = child
    const groupSignal = vi.spyOn(processGroups, 'signalProcessGroup')
    const groupExit = vi.spyOn(processGroups, 'waitForProcessGroupExit')
    const physicalClose = child.close.bind(child)
    const physicalObservation = (child as any).waitForChildClose.bind(child)
    let observations = 0
    ;(child as any).waitForChildClose = async (deadline: number) => {
      observations++
      expect(await physicalObservation(deadline)).toBe(true)
      return !(rejectDirect && observations === 1)
    }
    let closes = 0
    child.close = (reason) => {
      if (reason) return physicalClose(reason)
      closes++
      return physicalClose()
    }
    container.wire = {
      request: async () => {
        throw new CursorError('fixture_manager_refused')
      },
      releaseAfterRetirement: () => {},
    } as unknown as CursorWire
    try {
      await writeMarker(
        fence,
        { state: 'dirty', identity: container.identity, owner },
        limits,
        true,
      )
      await expect(container.close()).rejects.toMatchObject({
        code: 'cursor_cleanup_failed',
        failures: {
          reply: 'fixture_manager_refused',
          ...(rejectDirect
            ? { direct: 'cursor_cleanup_operation_failed' }
            : {}),
        },
      })
      expect(closes).toBe(1)
      const done = await child.done
      const signalCalls = groupSignal.mock.calls.slice()
      const exitCalls = groupExit.mock.calls.slice()
      if (rejectDirect) {
        const first = container.close(),
          second = container.close()
        expect(first).toBe(second)
        await expect(first).rejects.toMatchObject({
          code: 'cursor_cleanup_failed',
        })
        expect(closes).toBe(2)
        expect(observations).toBe(2)
        expect(await child.done).toBe(done)
        expect(groupSignal.mock.calls).toEqual(signalCalls)
        expect(groupExit.mock.calls).toEqual(exitCalls)
      }
      await expect(lstat(`/proc/${original!.pid}`)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect([
        child.child.stdin.destroyed,
        child.child.stdout.destroyed,
        child.child.stderr.destroyed,
      ]).toEqual([true, true, true])
      expect(resources.snapshot().containers).toBe(1)
      expect((await lstat(fence)).isFile()).toBe(true)
      await writeFile(
        `${prefix}-end.json`,
        JSON.stringify({
          original,
          directCalls: closes,
          originalProcessAbsent: true,
          pipesDestroyed: true,
          serviceRetirement: 'unproved synthetic refusal',
          fenceRetained: true,
          containerCharge: 1,
        }),
        { flag: 'wx' },
      )
      await writeMarker(
        `${fence}.retired`,
        {
          identity: container.identity,
          pipesClosed: true,
          proof: { kind: 'removed' },
          synthetic: true,
        },
        limits,
        true,
      )
      const first = container.close(),
        second = container.close()
      expect(first).toBe(second)
      await first
      expect(await child.done).toBe(done)
      await expect(lstat(fence)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(
        Object.values(resources.snapshot()).every((value) => value === 0),
      ).toBe(true)
    } finally {
      groupSignal.mockRestore()
      groupExit.mockRestore()
      await physicalClose().catch(() => {})
      await writeFile(
        `${prefix}-cleanup.json`,
        JSON.stringify({
          original,
          originalProcessAbsent: await lstat(`/proc/${original!.pid}`).then(
            () => false,
            (error) => {
              if (error.code === 'ENOENT') return true
              throw error
            },
          ),
          pipesDestroyed: [
            child.child.stdin.destroyed,
            child.child.stdout.destroyed,
            child.child.stderr.destroyed,
          ],
        }),
        { flag: 'wx' },
      )
      release()
      await rm(root, { recursive: true, force: true })
    }
  }
})

it('retains the writer fence and container charge when done resolves but direct close rejects', async () => {
  const root = await mkdtemp('/tmp/forge-cursor-close-'),
    limits = cursorLimits(),
    resources = createCursorResources(),
    fence = join(root, 'writer-fence.json')
  const owner: CursorOwner = {
    forgeSessionId: 'test',
    provider: 'cursor',
    accountId: 'test',
    cwd: root,
    storeId: randomUUID(),
    generation: randomUUID(),
    attemptId: 'attempt',
    runId: 'run',
    turnId: 'turn',
  }
  const container = new CursorContainer(
    {} as CursorLaunch,
    owner,
    join(root, 'sdk'),
    resources,
    limits,
    () => {},
  )
  container.identity = {
    unit: `forge-cursor-${randomUUID()}.service`,
    nonce: randomUUID(),
    generation: owner.generation,
    leaseId: randomUUID(),
    boot: 'fixture',
    host: 'fixture',
  }
  const close = vi.fn(async () => {
    throw new Error('fixture close rejected')
  })
  container.process = {
    done: Promise.resolve(),
    close,
  } as unknown as NativeProcess
  container.wire = {
    request: vi.fn(async (type: string) => ({
      type: type === 'retire' ? 'retired' : 'closed',
    })),
  } as unknown as CursorWire
  const release = resources.reserveContainer(fence, limits)
  ;(container as unknown as { release: () => void }).release = release
  try {
    await writeMarker(
      fence,
      { state: 'dirty', identity: container.identity, owner },
      limits,
      true,
    )
    await container.process.done
    const first = container.close(),
      second = container.close()
    expect(first).toBe(second)
    await expect(first).rejects.toThrow('cursor_cleanup_failed')
    await expect(second).rejects.toThrow('cursor_cleanup_failed')
    expect(close).toHaveBeenCalledTimes(1)
    expect(resources.snapshot().containers).toBe(1)
    expect((await lstat(fence)).isFile()).toBe(true)
    expect(() => resources.reserveContainer(fence, limits)).toThrow(
      'lease_busy',
    )
  } finally {
    release()
    await rm(root, { recursive: true, force: true })
  }
})

it('retains an unproved original group failure instead of signalling its numeric PID again', async () => {
  const runtime = (
    await NativeProcess.start(
      {
        command: process.execPath,
        args: [
          '-e',
          "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)",
        ],
        killGraceMs: 10,
      },
      async (owner) => {
        await once(owner.child.stdout, 'data')
      },
    )
  ).process
  const originalClose = once(runtime.child, 'close')
  const groupSignal = vi.spyOn(processGroups, 'signalProcessGroup')
  const groupExit = vi
    .spyOn(processGroups, 'waitForProcessGroupExit')
    .mockRejectedValueOnce(new Error('Synthetic original group proof refused'))
  try {
    const first = runtime.close()
    await expect(first).rejects.toThrow('Native process group cleanup failed')
    await originalClose
    const signals = groupSignal.mock.calls.slice()
    const observations = groupExit.mock.calls.slice()
    const reason = await runtime.done
    const retry = runtime.close()
    expect(retry).toBe(first)
    expect(runtime.close()).toBe(first)
    await expect(retry).rejects.toThrow('Native process group cleanup failed')
    expect(await runtime.done).toBe(reason)
    expect(groupSignal.mock.calls).toEqual(signals)
    expect(groupExit.mock.calls).toEqual(observations)
    expect(signals.filter(([, signal]) => signal === 'SIGKILL')).toHaveLength(1)
  } finally {
    groupSignal.mockRestore()
    groupExit.mockRestore()
    await runtime.close().catch(() => {})
    await originalClose
  }
})
