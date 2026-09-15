import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { HarnessHandle } from '../types.js'
import { expectStopped } from '../transport-test-helpers.js'
import { createCustomAcpAdapter, createGrokAdapter } from './providers.js'
import { createAcpFilesystem } from './filesystem.js'
import { createAcpTerminals } from './terminals.js'
import { sdkFixture } from './sdk-test-helpers.js'
import { acpProviderDescriptors } from './profiles.js'

function installServices(f: Awaited<ReturnType<typeof sdkFixture>>) {
  const generations: Array<{ public: string; transport: string }> = []
  f.deps.services = async (connection, history) => {
    generations.push({
      public: connection.generation,
      transport: connection.transportGeneration,
    })
    const options = {
      session: connection.session,
      runtimeGeneration: connection.generation,
      transportGeneration: connection.transportGeneration,
      binding: () => connection.binding,
      rpc: connection.rpc,
      host: f.deps.host,
      instanceId: 'instance',
    }
    return {
      filesystem: await createAcpFilesystem(options),
      terminals: await createAcpTerminals({
        ...options,
        account: connection.account,
        history,
        approvedEnv: {},
      }),
    }
  }
  return generations
}

describe('SDK callbacks through typed ACP services', () => {
  test.each(['filesystem', 'terminal'] as const)(
    'uses the real %s service and releases original owners',
    async (scenario) => {
      const f = await sdkFixture(scenario)
      installServices(f)
      let handle: HarnessHandle | undefined
      try {
        handle = await createCustomAcpAdapter(f.deps).spawn(
          f.session,
          (event) => f.events.push(event),
        )
        const receipt = await handle.prompt('SDK service acceptance')
        expect((await receipt.completion).status).toBe('completed')
        const text = f.events
          .filter((event) => event.type === 'text_delta')
          .map((event) => event.text)
          .join('')
        if (scenario === 'filesystem') {
          expect(text).toBe('SDK file.\r\nSecond line.é')
          expect(await readFile(join(f.session.cwd, 'sdk-file.txt'))).toEqual(
            Buffer.from(text),
          )
        } else {
          const output = JSON.parse(text)
          expect(output).toMatchObject({
            cwd: f.session.cwd,
            text: 'SDK terminal',
          })
          await expectStopped(output.pid)
        }
        const frames = await f.frames()
        const replies = frames.filter((frame) => Object.hasOwn(frame, 'result'))
        expect(replies).toHaveLength(scenario === 'filesystem' ? 2 : 4)
        expect(new Set(replies.map((frame) => frame.id)).size).toBe(
          replies.length,
        )
        expect(f.failures).toEqual([])
        await handle.kill()
        f.deps.host.reserve('instance', 'filesystem', 8)()
        f.deps.host.reserve('instance', 'terminals', 8)()
        f.deps.host.reserve('instance', 'processes', 8)()
        f.deps.host.reserve('instance', 'descriptors', 256)()
        f.deps.host.reserve('instance', 'retained', 128 * 1024 * 1024)()
      } finally {
        await f.cleanup(handle)
      }
    },
    15000,
  )
  test.each(['filesystem', 'terminal'] as const)(
    'keeps %s callbacks valid across transport-only policy replacement',
    async (scenario) => {
      const f = await sdkFixture(scenario)
      const generations = installServices(f)
      f.deps.launch = {
        ...f.deps.launch,
        args: acpProviderDescriptors.grok.args,
      }
      let handle: HarnessHandle | undefined
      try {
        handle = await createGrokAdapter({
          ...f.deps,
          grokRail: 'public',
        }).spawn(f.session, (event) => f.events.push(event))
        for (const permissionMode of ['manual', 'yolo', 'manual'] as const) {
          const receipt = await handle.prompt('Service after replacement', {
            permissionMode,
          })
          expect((await receipt.completion).status).toBe('completed')
        }
        expect(generations).toHaveLength(3)
        expect(new Set(generations.map((value) => value.public)).size).toBe(1)
        expect(new Set(generations.map((value) => value.transport)).size).toBe(
          3,
        )
        expect(f.writerOpens).toHaveLength(1)
        const texts = f.events
          .filter((event) => event.type === 'text_delta')
          .map((event) => event.text)
        expect(texts).toHaveLength(3)
        if (scenario === 'terminal')
          for (const text of texts) await expectStopped(JSON.parse(text).pid)
        else expect(texts).toEqual(Array(3).fill('SDK file.\r\nSecond line.é'))
        expect(f.failures).toEqual([])
        await handle.kill()
        f.deps.host.reserve('instance', 'filesystem', 8)()
        f.deps.host.reserve('instance', 'terminals', 8)()
        f.deps.host.reserve('instance', 'processes', 8)()
        f.deps.host.reserve('instance', 'descriptors', 256)()
        f.deps.host.reserve('instance', 'retained', 128 * 1024 * 1024)()
      } finally {
        await f.cleanup(handle)
      }
    },
    15000,
  )
})
