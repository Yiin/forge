import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test, vi } from 'vitest'
import type { HarnessHandle } from '../types.js'
import { deferred } from '../transport-test-helpers.js'
import { createGrokAdapter } from './providers.js'
import { acpProviderDescriptors } from './profiles.js'
import { sdkFixture } from './sdk-test-helpers.js'

describe('retirement after original ACP child work', () => {
  test('releases more than128 completed child owners and preserves held and late original evidence', async () => {
    const entered = deferred<void>(),
      held = deferred<void>()
    let firstChild = true
    const f = await sdkFixture('late-child-retirement', async (transaction) => {
      if (
        firstChild &&
        transaction.records.some(
          (record) =>
            record.value.kind === 'event' &&
            record.value.event.type === 'text_delta' &&
            record.value.event.childId,
        )
      ) {
        firstChild = false
        entered.resolve()
        await held.promise
      }
    })
    f.deps.launch = {
      ...f.deps.launch,
      command: fileURLToPath(
        new URL('./__fixtures__/provider-agent.mjs', import.meta.url),
      ),
      args: acpProviderDescriptors.grok.args,
    }
    let handle: HarnessHandle | undefined
    let firstRun: string | undefined
    try {
      handle = await createGrokAdapter({ ...f.deps, grokRail: 'public' }).spawn(
        f.session,
        (event) => f.events.push(event),
      )
      for (let index = 1; index <= 129; index++) {
        const receipt = await handle.prompt(`Root ${index}`)
        const result = await receipt.completion
        expect(result.status).toBe('completed')
        if (index === 1) firstRun = result.runId
        await writeFile(
          join(f.session.cwd, `finish-child-${index}`),
          'finish original child',
        )
        if (index === 1) {
          await entered.promise
          expect(
            f.events.filter((event) => event.type === 'child_finished'),
          ).toHaveLength(0)
          expect(f.failures).toEqual([])
          held.resolve()
        }
        await vi.waitFor(
          () =>
            expect(
              f.events.filter((event) => event.type === 'child_finished'),
            ).toHaveLength(index),
          { timeout: 3000, interval: 1 },
        )
      }
      expect(
        f.events.filter(
          (event) => event.type === 'text_delta' && event.childId,
        ),
      ).toHaveLength(129)
      expect(
        f.events.filter(
          (event) => event.type === 'text_delta' && !event.childId,
        ),
      ).toHaveLength(129)
      const before = f.events.length
      await writeFile(
        join(f.session.cwd, 'late-response'),
        'late exact first response',
      )
      await vi.waitFor(() =>
        expect(
          f.events
            .slice(before)
            .some(
              (event) =>
                event.type === 'usage_snapshot' &&
                event.runId === firstRun &&
                event.tokens?.outputTokens === 99,
            ),
        ).toBe(true),
      )
      expect(
        f.events.slice(before).some((event) => event.type === 'text_delta'),
      ).toBe(false)
      expect(
        f.events.filter((event) => event.type === 'turn_completed'),
      ).toHaveLength(129)
      expect(f.failures).toEqual([])
      await handle.kill()
      f.deps.host.reserve('instance', 'processes', 8)()
      f.deps.host.reserve('instance', 'retained', 128 * 1024 * 1024)()
    } finally {
      held.resolve()
      await f.cleanup(handle)
    }
  }, 30000)
})
