import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { HarnessEvent, HarnessHandle } from '../types.js'
import { deferred, expectStopped } from '../transport-test-helpers.js'
import {
  createTypedAcpAdapter,
  type AcpRuntimeDependencies,
} from './runtime.js'
import { AcpResourceHost } from './limits.js'
import { AcpConnection, type AcpConnectionOptions } from './connection.js'
import { captureNumbers } from './numbers.js'
import {
  committedPrefix,
  emptyPrefix,
  type PrefixTransaction,
} from './ingestion.js'
const command = fileURLToPath(
  new URL('./__fixtures__/agent.mjs', import.meta.url),
)
const session = { id: 'session', provider: 'instance', cwd: '/var/tmp' }

it('retains child history until the original snapshot persistence succeeds', async () => {
  const f = await fixture()
  const entered = deferred<void>(),
    release = deferred<void>()
  const snapshots: unknown[] = []
  let refuse = true
  f.deps.saveChildHistory = async (owner, history) => {
    expect(owner).toEqual(session)
    snapshots.push(history)
    entered.resolve()
    await release.promise
    if (refuse) throw Error('Original history persistence refused')
  }
  let handle: HarnessHandle | undefined
  try {
    handle = await createTypedAcpAdapter(f.deps).spawn(session, (event) =>
      f.events.push(event),
    )
    const closing = Promise.resolve(handle.kill())
    const rejection = expect(closing).rejects.toThrow(
      'Original history persistence refused',
    )
    await entered.promise
    expect(() =>
      f.deps.host.reserve('instance', 'retained', 128 * 1024 * 1024),
    ).toThrow('resource limit')
    release.resolve()
    await rejection
    refuse = false
    await handle.kill()
    expect(snapshots).toHaveLength(2)
    expect(snapshots[1]).toEqual(snapshots[0])
    f.deps.host.reserve('instance', 'retained', 128 * 1024 * 1024)()
  } finally {
    release.resolve()
    refuse = false
    await f.cleanup(handle)
  }
})
async function fixture(
  scenario = 'normal',
  beforeCommit?: (transaction: PrefixTransaction) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'forge-acp-runtime-')),
    report = join(directory, 'report.jsonl')
  const events: HarnessEvent[] = [],
    transactions: PrefixTransaction[] = []
  let artifact = 0
  const deps: AcpRuntimeDependencies = {
    profile:
      scenario.startsWith('grok-') || scenario === 'questions'
        ? 'grok'
        : 'custom-acp',
    grokRail: 'comet',
    launch: {
      providerInstanceId: 'instance',
      account: { kind: 'native-default', configurationId: 'config' },
      command,
      args:
        scenario.startsWith('grok-') || scenario === 'questions'
          ? ['agent', 'stdio']
          : [],
      env: { FORGE_ACP_TEST_SCENARIO: scenario, FORGE_ACP_TEST_REPORT: report },
    },
    host: new AcpResourceHost(),
    ingestion: {
      async open() {
        return {
          journalId: 'journal',
          writerEpoch: 'epoch',
          committedThrough: 0,
          prefixHash: emptyPrefix('journal'),
          async commit(transaction) {
            transactions.push(transaction)
            await beforeCommit?.(transaction)
            return {
              transactionId: transaction.transactionId,
              throughOrdinal: transaction.throughOrdinal,
              prefixHash: committedPrefix(transaction),
            }
          },
          async close() {},
        }
      },
    },
    contentStore: {
      async put(input) {
        return {
          artifactId: `artifact-${++artifact}`,
          mime: input.mime,
          bytes: input.bytes.byteLength,
          sha256: createHash('sha256').update(input.bytes).digest('hex'),
        }
      },
      async discard() {},
    },
    authorizedAttachment: async () => {
      throw Error('No test attachments')
    },
    broker: {
      admit() {
        return { retire() {} }
      },
    },
    async services() {
      const service = {
        async receive() {
          return false
        },
        async close() {},
      }
      return { filesystem: service, terminals: service }
    },
    failure() {},
  }
  return {
    deps,
    events,
    transactions,
    async cleanup(handle?: HarnessHandle) {
      await handle?.kill()
      const rows = await readFile(report, 'utf8').catch(() => '')
      for (const row of rows.trim().split('\n').filter(Boolean)) {
        const value = JSON.parse(row)
        if (value.event === 'spawned') await expectStopped(value.pid)
      }
      await rm(directory, { recursive: true, force: true })
    },
  }
}
describe('typed ACP root runtime', () => {
  it('settles every accepted receipt when original process cleanup refuses', async () => {
    const f = await fixture('error-prompt'),
      entered = deferred<void>(),
      gate = deferred<void>()
    f.deps.host = new AcpResourceHost({ processes: [1, 1] })
    const services = f.deps.services
    let restore: (() => void) | undefined, handle: HarnessHandle | undefined
    f.deps.services = async (io, history) => {
      const spy = vi.spyOn(io, 'retireProcess').mockImplementation(async () => {
        entered.resolve()
        await gate.promise
        throw Error('original cleanup refused')
      })
      restore = () => spy.mockRestore()
      return services(io, history)
    }
    try {
      handle = await createTypedAcpAdapter(f.deps).spawn(session, (event) =>
        f.events.push(event),
      )
      const first = await handle.prompt('first'),
        second = await handle.prompt('queued')
      let completed = false
      void first.completion
        .finally(() => {
          completed = true
        })
        .catch(() => {})
      await entered.promise
      expect(completed).toBe(false)
      expect(() => f.deps.host.reserve('instance', 'processes')).toThrow(
        'limit',
      )
      gate.resolve()
      expect(await first.completion).toMatchObject({
        status: 'failed',
        code: 'acp_cleanup_failed',
      })
      expect(await second.completion).toMatchObject({ status: 'failed' })
      expect(() => f.deps.host.reserve('instance', 'processes')).toThrow(
        'limit',
      )
      restore?.()
      await handle.kill()
      f.deps.host.reserve('instance', 'processes')()
    } finally {
      gate.resolve()
      restore?.()
      await f.cleanup(handle)
    }
  })
  it('fences an adjacent text update after required source storage fails', async () => {
    const f = await fixture()
    f.deps.contentStore.put = async () => {
      throw Error('required source failed')
    }
    // The normal peer sends thought, text, and tool frames in one burst. Add
    // metadata to the first thought so its required source write fails.
    f.deps.launch = {
      ...f.deps.launch,
      command: process.execPath,
      args: [
        '-e',
        `
      const readline=require('node:readline');
      const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
      readline.createInterface({input:process.stdin}).on('line',line=>{
        const m=JSON.parse(line);
        if(m.method==='initialize') send({id:m.id,result:{protocolVersion:1,agentCapabilities:{}}});
        if(m.method==='session/new') send({id:m.id,result:{sessionId:'native'}});
        if(m.method==='session/prompt') {
          send({method:'session/update',params:{sessionId:'native',update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'first'},_meta:{required:true}}}});
          send({method:'session/update',params:{sessionId:'native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'must not publish'}}}});
          send({id:m.id,result:{stopReason:'end_turn'}});
        }
      });
    `,
      ],
    }
    let handle: HarnessHandle | undefined
    try {
      handle = await createTypedAcpAdapter(f.deps).spawn(session, (event) =>
        f.events.push(event),
      )
      const receipt = await handle.prompt('fail content')
      await expect(receipt.completion).rejects.toMatchObject({
        code: 'completion_not_committed',
      })
      expect(
        f.events.some(
          (event) =>
            event.type === 'text_delta' && event.text === 'must not publish',
        ),
      ).toBe(false)
    } finally {
      await f.cleanup(handle)
    }
  })
  it('reserves snapshot capacity before inspecting caller input and rolls back refusal', async () => {
    const f = await fixture()
    let handle: HarnessHandle | undefined, release: (() => void) | undefined
    try {
      handle = await createTypedAcpAdapter(f.deps).spawn(session, (event) =>
        f.events.push(event),
      )
      release = f.deps.host.reserve('instance', 'retained', 104 * 1024 * 1024)
      let inspected = false
      const input = new Proxy([], {
        ownKeys() {
          inspected = true
          throw Error('caller inspected')
        },
      })
      expect(() => handle!.prompt(input)).toThrow('resource limit')
      expect(inspected).toBe(false)
      expect(() =>
        handle!.prompt('\u0000'.repeat(2 * 1024 * 1024 - 1024)),
      ).toThrow('resource limit')
      release()
      release = undefined
      const receipt = await handle.prompt('after refusal')
      expect(await receipt.completion).toMatchObject({ status: 'completed' })
    } finally {
      release?.()
      await f.cleanup(handle)
    }
  })
  it('releases replay normalizer state after a native load rejection', async () => {
    const f = await fixture()
    f.deps.launch = {
      ...f.deps.launch,
      command: process.execPath,
      args: [
        '-e',
        `
      const readline=require('node:readline');
      const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
      readline.createInterface({input:process.stdin}).on('line',line=>{
        const m=JSON.parse(line);
        if(m.method==='initialize') send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
        if(m.method==='session/load') {
          send({method:'session/update',params:{sessionId:'native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'history'},_meta:{native:true}}}});
          send({method:'session/update',params:{sessionId:'native',update:{sessionUpdate:'tool_call',toolCallId:'old-tool',title:'History tool',status:'completed',rawInput:null,content:[{type:'content',content:{type:'text',text:'old output'}}]}}});
          send({id:m.id,error:{code:-32000,message:'load rejected'}});
        }
      });
    `,
      ],
    }
    try {
      for (let count = 0; count < 2; count++) {
        await expect(
          createTypedAcpAdapter(f.deps).load!(
            {
              ...session,
              binding: {
                provider: 'instance',
                accountId: null,
                cwd: session.cwd,
                providerSessionId: 'native',
              },
            },
            (event) => f.events.push(event),
          ),
        ).rejects.toThrow()
        f.deps.host.reserve('instance', 'retained', 128 * 1024 * 1024)()
      }
      expect(f.events).toEqual([])
      expect(
        f.transactions
          .flatMap((tx) => tx.records)
          .some((record) => record.value.kind === 'replay'),
      ).toBe(true)
    } finally {
      await f.cleanup()
    }
  })
  it('does not lend the new root authority to an earlier captured chunk owner', async () => {
    const f = await fixture(),
      entered = deferred<void>(),
      gate = deferred<void>()
    f.deps.profile = 'grok'
    f.deps.grokRail = 'public'
    f.deps.launch = {
      ...f.deps.launch,
      command: fileURLToPath(
        new URL('./__fixtures__/provider-agent.mjs', import.meta.url),
      ),
      args: ['agent', 'stdio'],
      env: { ...f.deps.launch.env, FORGE_ACP_TEST_SCENARIO: 'grok-responses' },
    }
    let route!: AcpConnectionOptions['route'],
      earlier!: Parameters<AcpConnectionOptions['route']>[1],
      newer!: Parameters<AcpConnectionOptions['route']>[1],
      transport = ''
    const originalOpen = AcpConnection.open
    const openSpy = vi
      .spyOn(AcpConnection, 'open')
      .mockImplementation((options, ...args) => {
        route = options.route
        return originalOpen.call(AcpConnection, options, ...args)
      })
    const service = f.deps.services
    f.deps.services = async (io, history) => {
      const call = io.call.bind(io)
      let prompts = 0
      vi.spyOn(io, 'call').mockImplementation(
        (method, params, owner, options) => {
          const result = call(method, params, owner, options)
          if (method === 'session/prompt') {
            if (++prompts === 1) {
              earlier = owner
              transport = io.transportGeneration
            } else {
              newer = owner
              return {
                ...result,
                response: result.response.then(async (value) => {
                  entered.resolve()
                  await gate.promise
                  return value
                }),
              }
            }
          }
          return result
        },
      )
      return service(io, history)
    }
    let handle: HarnessHandle | undefined
    try {
      handle = await createTypedAcpAdapter(f.deps).spawn(session, () => {})
      const first = await handle.prompt('first')
      await first.completion
      const second = await handle.prompt('second')
      await entered.promise
      // These bytes retained the first read owner before their admission paused.
      const wire = JSON.stringify({
        method: '_x.ai/session/update',
        params: {
          sessionId:
            earlier.phase === 'live' ? earlier.binding.providerSessionId : '',
          update: {
            sessionUpdate: 'subagent_spawned',
            subagent_id: 'late-child',
            child_session_id: 'child',
            parent_session_id:
              earlier.phase === 'live' ? earlier.binding.providerSessionId : '',
          },
        },
      })
      const strings: Record<string, string> = {}
      const numbers = captureNumbers(wire, (path, value) => {
        strings[path] = value
      })
      const selected = route(strings, earlier, numbers, 1000, transport)
      expect(('owner' in selected ? selected.owner : selected).phase).toBe(
        'control',
      )
      const redirected = JSON.parse(wire)
      redirected.params.update.message_id = 'native-one'
      const redirectedStrings: Record<string, string> = {}
      const redirectedNumbers = captureNumbers(
        JSON.stringify(redirected),
        (path, value) => {
          redirectedStrings[path] = value
        },
      )
      const redirectedOwner = route(
        redirectedStrings,
        newer,
        redirectedNumbers,
        1001,
        transport,
      )
      expect(
        ('owner' in redirectedOwner ? redirectedOwner.owner : redirectedOwner)
          .phase,
      ).toBe('control')
      gate.resolve()
      await second.completion
    } finally {
      gate.resolve()
      openSpy.mockRestore()
      await f.cleanup(handle)
    }
  })
  it.each([false, true])(
    'retires lifetime-expired resources after accepted work settles: active=%s',
    async (active) => {
      const entered = deferred<void>(),
        gate = deferred<void>()
      const f = await fixture('normal', async (tx) => {
        if (
          active &&
          tx.records.some(
            (record) =>
              record.value.kind === 'event' &&
              record.value.event.type === 'turn_completed',
          )
        ) {
          entered.resolve()
          await gate.promise
        }
      })
      f.deps.host = new AcpResourceHost({ processes: [1, 1] })
      const timerSpy = vi.spyOn(globalThis, 'setTimeout')
      let handle: HarnessHandle | undefined, restore: (() => void) | undefined
      try {
        handle = await createTypedAcpAdapter(f.deps).spawn(session, (event) =>
          f.events.push(event),
        )
        const receipt = active ? await handle.prompt('accepted') : undefined
        if (active) await entered.promise
        const callback = timerSpy.mock.calls.find(
          (call) => Number(call[1]) > 23 * 60 * 60 * 1000,
        )![0] as () => void
        const clock = vi
          .spyOn(Date, 'now')
          .mockReturnValue(Date.now() + 24 * 60 * 60 * 1000 + 60000)
        restore = () => clock.mockRestore()
        expect(handle.requiresResume).toBe(true)
        callback()
        if (active) {
          expect(() => f.deps.host.reserve('instance', 'processes')).toThrow(
            'limit',
          )
          gate.resolve()
          expect(await receipt!.completion).toMatchObject({
            status: 'completed',
          })
        }
        await vi.waitFor(() => f.deps.host.reserve('instance', 'processes')())
        await handle.kill()
        f.deps.host.reserve('instance', 'retained', 128 * 1024 * 1024)()
      } finally {
        gate.resolve()
        restore?.()
        timerSpy.mockRestore()
        await f.cleanup(handle)
      }
    },
  )
  it('refuses new roots after the public handle reaches its age limit', async () => {
    const f = await fixture()
    let handle: HarnessHandle | undefined
    const now = Date.now()
    let restore: (() => void) | undefined
    try {
      handle = await createTypedAcpAdapter(f.deps).spawn(session, (event) =>
        f.events.push(event),
      )
      const clock = vi
        .spyOn(Date, 'now')
        .mockReturnValue(now + 24 * 60 * 60 * 1000 + 60000)
      restore = () => clock.mockRestore()
      expect(() => handle!.prompt('expired')).toThrow('prompt limit')
      expect(f.events).toEqual([])
    } finally {
      restore?.()
      await f.cleanup(handle)
    }
  })
  it('returns typed receipts and waits for the required terminal prefix', async () => {
    const entered = deferred<void>(),
      release = deferred<void>()
    const f = await fixture('normal', async (tx) => {
      if (
        tx.records.some(
          (record) =>
            record.value.kind === 'event' &&
            record.value.event.type === 'turn_completed',
        )
      ) {
        entered.resolve()
        await release.promise
      }
    })
    let handle: HarnessHandle | undefined
    try {
      handle = await createTypedAcpAdapter(f.deps).spawn(session, (event) =>
        f.events.push(event),
      )
      const receipt = await handle.prompt('Hello', undefined, {
        runId: 'root',
        turnId: 'turn',
      })
      let completed = false
      void receipt.completion.then(() => {
        completed = true
      })
      await entered.promise
      expect(completed).toBe(false)
      release.resolve()
      expect(await receipt.completion).toEqual({
        status: 'completed',
        runId: 'root',
        turnId: 'turn',
      })
      expect(
        f.events.some(
          (event) => event.type === 'text_delta' && event.text === 'Hello.',
        ),
      ).toBe(true)
    } finally {
      release.resolve()
      await f.cleanup(handle)
    }
  })
  it('rejects completion when its required terminal commit fails', async () => {
    const f = await fixture('normal', async (transaction) => {
      if (
        transaction.records.some(
          (record) =>
            record.value.kind === 'event' &&
            record.value.event.type === 'turn_completed',
        )
      )
        throw Error('durability failed')
    })
    let handle: HarnessHandle | undefined
    try {
      handle = await createTypedAcpAdapter(f.deps).spawn(session, (event) =>
        f.events.push(event),
      )
      const receipt = await handle.prompt('fail')
      await expect(receipt.completion).rejects.toMatchObject({
        code: 'persistence_unknown',
        runId: receipt.runId,
        turnId: receipt.turnId,
      })
      expect(f.events.some((event) => event.type === 'turn_completed')).toBe(
        false,
      )
    } finally {
      await f.cleanup(handle)
    }
  })
  it('keeps repeated kill calls behind original service cleanup', async () => {
    const f = await fixture(),
      entered = deferred<void>(),
      gate = deferred<void>()
    let handle: HarnessHandle | undefined
    f.deps.services = async () => ({
      filesystem: {
        async receive() {
          return false
        },
        async close() {
          entered.resolve()
          await gate.promise
        },
      },
      terminals: {
        async receive() {
          return false
        },
        async close() {},
      },
    })
    try {
      handle = await createTypedAcpAdapter(f.deps).spawn(session, (event) =>
        f.events.push(event),
      )
      const first = Promise.resolve(handle.kill())
      await entered.promise
      let secondDone = false
      const second = Promise.resolve(handle.kill()).then(() => {
        secondDone = true
      })
      await Promise.resolve()
      expect(secondDone).toBe(false)
      gate.resolve()
      await Promise.all([first, second])
    } finally {
      gate.resolve()
      await f.cleanup(handle)
    }
  })
  it('rejects unsupported Gemini auto before accepting a receipt', async () => {
    const f = await fixture()
    f.deps.profile = 'gemini'
    f.deps.launch = { ...f.deps.launch, args: ['--experimental-acp'] }
    let handle: HarnessHandle | undefined
    try {
      handle = await createTypedAcpAdapter(f.deps).spawn(session, (event) =>
        f.events.push(event),
      )
      expect(() => handle!.prompt('no', { permissionMode: 'auto' })).toThrow(
        'auto',
      )
      expect(f.events.some((event) => event.type === 'prompt_accepted')).toBe(
        false,
      )
    } finally {
      await f.cleanup(handle)
    }
  })
  it('queues a second root with distinct stable receipts', async () => {
    const f = await fixture()
    let handle: HarnessHandle | undefined
    try {
      handle = await createTypedAcpAdapter(f.deps).spawn(session, (event) =>
        f.events.push(event),
      )
      const first = await handle.prompt('one'),
        second = await handle.prompt('two')
      expect(first.receiptId).not.toBe(second.receiptId)
      expect((await first.completion).status).toBe('completed')
      expect((await second.completion).status).toBe('completed')
      expect(
        f.events.filter((event) => event.type === 'turn_completed'),
      ).toHaveLength(2)
    } finally {
      await f.cleanup(handle)
    }
  })
  it('answers the original native permission and completes after denial', async () => {
    const f = await fixture('permission')
    let handle: HarnessHandle | undefined,
      reply: Promise<void> | void = undefined
    try {
      handle = await createTypedAcpAdapter(f.deps).spawn(session, (event) => {
        f.events.push(event)
        if (event.type === 'permission_requested')
          reply = handle!.replyPermission!({
            requestId: event.request.requestId,
            type: 'denied',
          })
      })
      const receipt = await handle.prompt('request')
      expect((await receipt.completion).status).toBe('interrupted')
      await reply
      expect(
        f.events.some((event) => event.type === 'permission_requested'),
      ).toBe(true)
    } finally {
      await f.cleanup(handle)
    }
  })
  it('cancels an owned native prompt without inventing a completed result', async () => {
    const f = await fixture('hang-prompt'),
      started = deferred<void>()
    let handle: HarnessHandle | undefined
    try {
      handle = await createTypedAcpAdapter(f.deps).spawn(session, (event) => {
        f.events.push(event)
        if (event.type === 'text_delta') started.resolve()
      })
      const receipt = await handle.prompt('hang')
      await started.promise
      await handle.cancel()
      expect((await receipt.completion).status).toBe('interrupted')
    } finally {
      await f.cleanup(handle)
    }
  })
  it('does not let an unknown Grok completion settle the foreground root', async () => {
    const seen = deferred<void>()
    const f = await fixture('grok-unknown-completion', async (transaction) => {
      if (transaction.records.some((record) => record.source.wireOrdinal === 9))
        seen.resolve()
    })
    let handle: HarnessHandle | undefined
    try {
      handle = await createTypedAcpAdapter(f.deps).spawn(session, (event) => {
        f.events.push(event)
      })
      const receipt = await handle.prompt('hang')
      let done = false
      void receipt.completion.then(() => {
        done = true
      })
      await seen.promise
      expect(done).toBe(false)
      await handle.cancel()
      expect((await receipt.completion).status).toBe('interrupted')
    } finally {
      await f.cleanup(handle)
    }
  })
})

it('marks the original handle for exact resume after 256 completed roots', async () => {
  const f = await fixture()
  let handle: HarnessHandle | undefined
  try {
    handle = await createTypedAcpAdapter(f.deps).spawn(session, (event) =>
      f.events.push(event),
    )
    expect(handle.requiresResume).toBe(false)
    for (let index = 0; index < 256; index++) {
      const receipt = await handle.prompt(`root ${index}`)
      expect(await receipt.completion).toMatchObject({ status: 'completed' })
    }
    expect(handle.requiresResume).toBe(true)
    expect(() => handle!.prompt('root 257')).toThrow()
    await handle.kill()
    expect(
      f.events.filter((event) => event.type === 'turn_completed'),
    ).toHaveLength(256)
    expect(
      f.events.filter((event) => event.type === 'run_failed'),
    ).toHaveLength(0)
  } finally {
    await f.cleanup(handle)
  }
}, 30000)
