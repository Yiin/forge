import { describe, expect, it } from 'vitest'
import { CodexBudget, MiB, byteSize } from './wire.js'
import { CodexNormalizer } from './normalize.js'
import { copyLaunchOptions, normalizeCodexArgs } from './environment.js'
import { createCodexAdapter } from './index.js'
import { peer, turn, notify, eventually } from './test-helpers.js'

// These unit cases prove the accounting primitive at each approved metadata ceiling.
// Owned-peer cases in bounds.test.ts prove admission through the production maps.
describe('Codex exact count and byte accounting', () => {
  it.each([
    ['pending calls', 128, 8 * MiB],
    ['callbacks', 128, 4 * MiB],
    ['ordinary attempt', 1, 4 * MiB + 64 * 1024],
    ['steering attempt', 1, 4 * MiB + 64 * 1024],
    ['preparations', 2, 8 * MiB + 128 * 1024],
    ['buffers', 1024, 8 * MiB],
    ['active children', 128, 2 * MiB],
    ['owners', 8192, 8 * MiB],
    ['full owners', 4096, 8 * MiB],
    ['lineage', 2048, 4 * MiB],
    ['child executions', 8192, 8 * MiB],
    ['items', 32768, 12 * MiB],
    ['streams', 4096, MiB],
    ['reasoning parts', 4096, MiB],
    ['echoes', 1024, MiB],
    ['assignments', 256, MiB],
    ['metadata reads', 68, 256 * 1024],
    ['metadata waiters', 1024, 256 * 1024],
    ['failed metadata', 256, 256 * 1024],
    ['global state', 33, 256 * 1024],
    ['startup diagnostics', 64, 64 * 1024],
    ['control resources', 512, 256 * 1024],
  ] as const)(
    '43, 72: %s admits exactly its count/bytes and atomically refuses one more',
    (name, count, bytes) => {
      const budget = new CodexBudget()
      const exactBytes = budget.charge(name, bytes - 128, count, bytes)
      expect(budget.bytes).toBe(bytes)
      expect(() => exactBytes.resize(bytes - 127)).toThrow('LIMIT')
      expect(budget.bytes).toBe(bytes)
      exactBytes()
      const releases = Array.from({ length: count }, () =>
        budget.charge(name, 0, count, bytes),
      )
      expect(() => budget.charge(name, 0, count, bytes)).toThrow('LIMIT')
      releases.forEach((release) => release())
      expect(budget.bytes).toBe(0)
    },
  )

  it('43: aggregate metadata permits exactly 32 MiB, including the record charge', () => {
    const budget = new CodexBudget()
    const release = budget.charge('all', 32 * MiB - 128, 1, 32 * MiB)
    expect(budget.bytes).toBe(32 * MiB)
    expect(() => release.resize(32 * MiB - 127)).toThrow('LIMIT')
    expect(() => budget.charge('other', 0, 1, MiB)).toThrow('LIMIT')
    release()
    expect(budget.bytes).toBe(0)
  })

  it('24, 43: tool aggregate permits exactly 8 MiB and refuses another byte before an event', () => {
    let events = 0
    const mapper = new CodexNormalizer(
      'generation',
      () => {
        events++
      },
      new CodexBudget(),
    )
    const owner = {
      runId: 'r',
      turnId: 'f',
      nativeThreadId: 'n',
      nativeTurnId: 't',
    }
    const item = {
      id: 'tool',
      type: 'commandExecution',
      command: 'fixture',
      commandActions: [],
      cwd: '/fixture',
      status: 'completed',
      aggregatedOutput: '',
    }
    item.aggregatedOutput = 'x'.repeat(8 * MiB - byteSize(item))
    mapper.item(owner, item, true)
    expect(events).toBe(2)
    expect(() =>
      mapper.item(
        owner,
        { ...item, aggregatedOutput: item.aggregatedOutput + 'x' },
        true,
      ),
    ).toThrow('TOOL_LIMIT')
    expect(events).toBe(2)
    mapper.close()
  })

  it('43: environment, arguments and secret references reject their first extra record', async () => {
    const p = await peer()
    const env = Object.fromEntries(
      Array.from({ length: 512 }, (_, index) => [`FIXTURE_${index}`, '']),
    )
    expect(
      Object.keys(
        copyLaunchOptions({ ...p.options, accountId: null, env }).env!,
      ),
    ).toHaveLength(512)
    expect(() =>
      copyLaunchOptions({
        ...p.options,
        accountId: null,
        env: { ...env, OVER: '' },
      }),
    ).toThrow('ENVIRONMENT_LIMIT')
    expect(
      normalizeCodexArgs(Array.from({ length: 128 }, () => '--fixture')),
    ).toHaveLength(130)
    expect(() =>
      normalizeCodexArgs(Array.from({ length: 129 }, () => '--fixture')),
    ).toThrow('ARGUMENT_LIMIT')
    expect(() =>
      createCodexAdapter({
        ...p.options,
        secrets: Array.from({ length: 256 }, () => 'fixture'),
      }),
    ).not.toThrow()
    expect(() =>
      createCodexAdapter({
        ...p.options,
        secrets: Array.from({ length: 257 }, () => 'fixture'),
      }),
    ).toThrow('SECRETS_LIMIT')
    const exact = 'x'.repeat(256 * 1024 - 4)
    expect(() =>
      createCodexAdapter({ ...p.options, secrets: [exact] }),
    ).not.toThrow()
    expect(() =>
      createCodexAdapter({ ...p.options, secrets: [exact + 'x'] }),
    ).toThrow('SECRETS_LIMIT')
  })

  it.each(['questions', 'options'])(
    '43, 72: native %s allows its full count and explicitly refuses one more',
    async (kind) => {
      const p = await peer([{ method: 'turn/start', result: { turn: turn() } }])
      const h = await p.start()
      await h.prompt('input')
      const frame = (overflow: boolean) => ({
        id: overflow ? 'overflow' : 'exact',
        method: 'item/tool/requestUserInput',
        params: {
          threadId: 'root',
          turnId: 't1',
          itemId: 'questions',
          questions: Array.from(
            { length: kind === 'questions' ? 64 + Number(overflow) : 1 },
            (_, index) => ({
              id: `question-${index}`,
              header: 'Fixture',
              question: 'Choose',
              options:
                kind === 'options'
                  ? Array.from(
                      { length: 128 + Number(overflow) },
                      (_, choice) => ({
                        label: `choice-${choice}`,
                        description: '',
                      }),
                    )
                  : null,
            }),
          ),
        },
      })
      await p.send([frame(false)])
      await eventually(() =>
        p.events.some((event) => event.type === 'question_requested'),
      )
      await p.send([
        notify('serverRequest/resolved', {
          threadId: 'root',
          requestId: 'exact',
        }),
        frame(true),
      ])
      await eventually(async () =>
        (await p.trace()).some((frame) => frame.id === 'overflow'),
      )
      expect(
        p.events.filter((event) => event.type === 'question_requested'),
      ).toHaveLength(1)
      expect(
        (await p.trace()).find((frame) => frame.id === 'overflow'),
      ).toMatchObject({ error: { code: -32601 } })
    },
  )
})
