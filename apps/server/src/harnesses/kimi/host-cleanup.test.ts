import { mkdtemp, rm } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { NativeCleanupError } from '../native-cleanup.js'
import { directoryIdentity, type EffectiveAuthority } from './authority.js'
import { KimiHostOwner } from './host.js'
import { KimiServer } from './server.js'

it.each(['held', 'proved', 'refused'] as const)(
  'joins the exact failed startup cleanup owner: %s',
  async (mode) => {
    const directory = await mkdtemp('/tmp/forge-kimi-host-cleanup-')
    const home = await directoryIdentity(directory)
    const authority: EffectiveAuthority = {
      home,
      executable: home,
      bootstrapCwd: directory,
      environment: {},
      selected: {
        provider: 'fixture',
        credentialPolicy: 'configured-native',
        environment: {},
        account: {
          id: 'fixture',
          harnessKey: 'fixture',
          label: 'Fixture',
          kind: 'kimi',
          adapterKind: 'native',
          homePath: directory,
          orderIndex: 0,
          disabledAt: null,
          createdAt: 0,
          lastUsedAt: null,
        },
        harness: {
          name: 'Fixture',
          command: process.execPath,
          args: [],
          env: {},
          protocol: 'acp',
          adapterKind: 'native',
          enabled: true,
        },
      },
    }
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const cleanup = vi.fn(async () => {
      if (mode === 'held') await held
      if (mode === 'refused') throw Error('unproved original cleanup')
    })
    const failure = new NativeCleanupError(cleanup)
    const start = vi.spyOn(KimiServer, 'start').mockRejectedValueOnce(failure)
    const host = new KimiHostOwner()
    try {
      await expect(host.acquire(authority, 'helper')).rejects.toBe(failure)
      expect(host.budget.count('hostHomes')).toBe(1)
      if (mode === 'proved') await failure.retryCleanup()
      const first = host.close()
      const second = host.close()
      const observed = Promise.allSettled([first, second])
      await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1))
      if (mode === 'held') expect(host.budget.count('hostHomes')).toBe(1)
      release()
      const results = await observed
      if (mode === 'refused') {
        expect(results).toEqual([
          { status: 'rejected', reason: failure },
          { status: 'rejected', reason: failure },
        ])
        expect(host.budget.count('hostHomes')).toBe(1)
      } else {
        expect(results).toEqual([
          { status: 'fulfilled', value: undefined },
          { status: 'fulfilled', value: undefined },
        ])
        expect(host.budget.count('hostHomes')).toBe(0)
        expect(host.budget.count('hostRetainedBytes')).toBe(0)
        await host.close()
        expect(cleanup).toHaveBeenCalledTimes(1)
      }
    } finally {
      release()
      start.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  },
)
