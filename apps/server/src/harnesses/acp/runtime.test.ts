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
import {
  committedPrefix,
  emptyPrefix,
  type PrefixTransaction,
} from './ingestion.js'
const command = fileURLToPath(
  new URL('./__fixtures__/agent.mjs', import.meta.url),
)
const session = { id: 'session', provider: 'instance', cwd: '/var/tmp' }
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
    f.deps.services = async (io) => {
      const spy = vi.spyOn(io, 'retireProcess').mockImplementation(async () => {
        entered.resolve()
        await gate.promise
        throw Error('original cleanup refused')
      })
      restore = () => spy.mockRestore()
      return services(io)
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
      expect(() => handle!.prompt('\u0000'.repeat(2 * 1024 * 1024 - 1024))).toThrow('resource limit')
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
