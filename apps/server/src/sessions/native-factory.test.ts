import { realpath } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import type { HarnessHandle } from '../harnesses/types.js'
import { convertConfig, defaultConfig } from '../config.js'
import {
  harnessTransport,
  hasProductionNativeAdapter,
  createNativeResources,
  createProductionNativeAdapter,
} from './native-factory.js'

describe('production native harness routing', () => {
  it('selects every shipped native provider without an ACP fallback', () => {
    const config = convertConfig(defaultConfig(false))
    for (const key of [
      'claude-code-acp',
      'codex-acp',
      'kimi',
      'opencode',
      'pi',
      'cursor',
    ]) {
      expect(hasProductionNativeAdapter(key)).toBe(true)
      expect(harnessTransport(key, config.harness[key])).toBe('native')
    }
    expect(
      harnessTransport('unknown', {
        adapterKind: 'native',
        protocol: 'acp',
      } as never),
    ).toBe('native')
    expect(hasProductionNativeAdapter('unknown')).toBe(false)
  })
  it('preserves intentional dedicated ACP and PTY', () => {
    expect(
      harnessTransport('grok', {
        adapterKind: 'acp',
        protocol: 'acp',
      } as never),
    ).toBe('acp')
    expect(
      harnessTransport('claude', {
        adapterKind: 'pty',
        protocol: 'pty',
      } as never),
    ).toBe('pty')
    expect(
      harnessTransport('custom', {
        adapterKind: 'custom',
        protocol: 'acp',
      } as never),
    ).toBe('acp')
  })
  it('converts only exact shipped wrappers and keeps IDs and selected custom commands', () => {
    const config = defaultConfig(false)
    config.harness['codex-acp'] = {
      ...config.harness['codex-acp'],
      command: 'npx',
      args: ['@zed-industries/codex-acp'],
    }
    config.harness.pi = {
      ...config.harness.pi,
      command: '/custom/pi',
      args: ['--custom-flag'],
    }
    const converted = convertConfig(config)
    expect(converted.harness['codex-acp'].command).toBe('codex')
    expect(converted.harness['codex-acp'].args).toEqual([])
    expect(converted.harness.pi.command).toBe('/custom/pi')
    expect(converted.harness.pi.args).toEqual(['--custom-flag'])
    expect(convertConfig(converted)).toEqual(converted)
  })
})

it('joins original startups and retains failed cleanup handles for the same-owner retry', async () => {
  const resources = createNativeResources()
  const tickets = Array.from({ length: 32 }, () => resources.reserveStartup())
  expect(() => resources.reserveStartup()).toThrow('capacity')
  let finished = false
  const closing = resources.close()
  void closing.then(
    () => {
      finished = true
    },
    () => {
      finished = true
    },
  )
  await Promise.resolve()
  expect(finished).toBe(false)
  expect(() => tickets[0].assertOpen()).toThrow('closed')
  const kill = vi
    .fn()
    .mockRejectedValueOnce(new Error('original cleanup refused'))
    .mockResolvedValue(undefined)
  tickets[0].retain({ kill } as unknown as HarnessHandle)
  for (const ticket of tickets) ticket.release()
  await expect(closing).rejects.toThrow('unresolved')
  expect(kill).toHaveBeenCalledTimes(1)
  await resources.close()
  expect(kill).toHaveBeenCalledTimes(2)
  expect(() => resources.reserveStartup()).toThrow('capacity')
})

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, realpath: vi.fn(fs.realpath) }
})
it('charges held workspace resolution and joins it before startup shutdown', async () => {
  const resources = createNativeResources()
  let release!: (path: string) => void
  const held = new Promise<string>((resolve) => {
    release = resolve
  })
  vi.mocked(realpath).mockReturnValue(held)
  const adapter = createProductionNativeAdapter('pi', {
    entry: {
      command: 'never-launch',
      args: [],
      env: {},
      enabled: true,
      adapterKind: 'native',
      protocol: 'acp',
    },
    resources,
  } as unknown as Parameters<typeof createProductionNativeAdapter>[1])
  const session = { id: 's', provider: 'pi', accountId: null, cwd: '/held' }
  const work = Array.from({ length: 32 }, () =>
    adapter.spawn(session, () => {}),
  )
  const outcomes = Promise.all(
    work.map((value) => expect(value).rejects.toThrow('closed')),
  )
  await expect(adapter.spawn(session, () => {})).rejects.toThrow('capacity')
  expect(realpath).toHaveBeenCalledTimes(32)
  let settled = false
  const closing = resources.close().then(() => {
    settled = true
  })
  await Promise.resolve()
  expect(settled).toBe(false)
  release('/held')
  await outcomes
  await closing
  expect(settled).toBe(true)
})
