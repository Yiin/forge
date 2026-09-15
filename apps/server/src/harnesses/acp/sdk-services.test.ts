import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { HarnessHandle } from '../types.js'
import { expectStopped } from '../transport-test-helpers.js'
import { createCustomAcpAdapter } from './providers.js'
import { createAcpFilesystem } from './filesystem.js'
import { createAcpTerminals } from './terminals.js'
import { sdkFixture } from './sdk-test-helpers.js'

describe('SDK callbacks through typed ACP services', () => {
  test.each(['filesystem', 'terminal'] as const)(
    'uses the real %s service and releases original owners',
    async (scenario) => {
      const f = await sdkFixture(scenario)
      f.deps.services = async (connection) => {
        const options = {
          session: connection.session,
          runtimeGeneration: connection.generation,
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
            approvedEnv: {},
          }),
        }
      }
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
})
