import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { deferred, expectStopped } from '../transport-test-helpers.js'
import { AcpConnection, type AcpConnectionOptions } from './connection.js'
import { AcpResourceHost } from './limits.js'
import { NativeProcess } from '../process.js'
import {
  committedPrefix,
  emptyPrefix,
  type PrefixTransaction,
  type AcpSessionWriter,
  type AcpRecordOwner,
} from './ingestion.js'
const command = fileURLToPath(
  new URL('./__fixtures__/agent.mjs', import.meta.url),
)
const session = { id: 'session', provider: 'instance', cwd: '/var/tmp' }
async function setup(
  scenario: string,
  beforeCommit?: (transaction: PrefixTransaction) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'forge-acp-connection-'))
  const report = join(directory, 'report.jsonl'),
    transactions: PrefixTransaction[] = [],
    phases: string[] = []
  const options: AcpConnectionOptions = {
    profile: 'custom-acp',
    launch: {
      providerInstanceId: 'instance',
      account: { kind: 'native-default', configurationId: 'config' },
      command,
      args: [],
      env: { FORGE_ACP_TEST_REPORT: report, FORGE_ACP_TEST_SCENARIO: scenario },
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
    route: (_strings, fallback) => fallback,
    async incoming(_message, frame) {
      phases.push(frame.owner.phase)
      frame.ticket.finish([
        {
          value: {
            kind: 'disposition',
            status:
              frame.owner.phase === 'load_replay' ? 'replay_staged' : 'ignored',
          },
        },
      ])
    },
    failure() {},
  }
  return {
    options,
    phases,
    transactions,
    async cleanup() {
      const rows = await readFile(report, 'utf8').catch(() => '')
      for (const row of rows.trim().split('\n').filter(Boolean)) {
        const value = JSON.parse(row)
        if (value.event === 'spawned') await expectStopped(value.pid)
      }
      await rm(directory, { recursive: true, force: true })
    },
  }
}
describe('ACP owned session connection', () => {
  it('claims only the first response in one chunk and commits the duplicate as ignored', async () => {
    const f = await setup('hang-prompt')
    let connection: AcpConnection | undefined
    try {
      connection = await AcpConnection.open(f.options, session, false)
      let id = ''
      const call = connection.call(
        'session/prompt',
        { sessionId: 'fixture-session', prompt: [] },
        connection.control,
        {
          onHandoff(value) {
            id = value
          },
        },
      )
      await call.submission
      connection.process.child.stdout.push(
        Buffer.from(
          JSON.stringify({ jsonrpc: '2.0', id, result: { first: true } }) +
            '\n' +
            JSON.stringify({ jsonrpc: '2.0', id, result: { first: false } }) +
            '\n',
        ),
      )
      const response = await call.response
      expect(response.value).toEqual({ first: true })
      response.frame.ticket.finish([
        { value: { kind: 'disposition', status: 'ignored' } },
      ])
      await response.frame.ticket.committed
      await connection.journal.append(connection.control, {
        kind: 'disposition',
        status: 'ignored',
      })
      const records = f.transactions.flatMap((t) => t.records)
      const ordinals = [...new Set(records.map((r) => r.admissionOrdinal))]
      expect(ordinals).toEqual(
        Array.from({ length: ordinals.length }, (_, i) => i + 1),
      )
      expect(
        records.filter(
          (r) => r.source.wireOrdinal === response.frame.wireOrdinal + 1,
        ),
      ).toHaveLength(1)
    } finally {
      await connection?.close()
      await f.cleanup()
    }
  })
  it('keeps late responses under their original owner after logical cancellation', async () => {
    const f = await setup('hang-prompt')
    let connection: AcpConnection | undefined
    try {
      connection = await AcpConnection.open(f.options, session, false)
      const old = { ...connection.control, startupId: 'old' }
      const newer = { ...connection.control, startupId: 'new' }
      const controller = new AbortController()
      let id = ''
      const call = connection.call(
        'session/prompt',
        { sessionId: 'fixture-session', prompt: [] },
        old,
        {
          signal: controller.signal,
          onHandoff(value) {
            id = value
          },
        },
      )
      await call.submission
      controller.abort()
      connection.setOwner(newer)
      queueMicrotask(() =>
        connection!.process.child.stdout.push(
          Buffer.from(
            JSON.stringify({
              jsonrpc: '2.0',
              id,
              result: { stopReason: 'end_turn' },
            }) + '\n',
          ),
        ),
      )
      await expect(call.response).rejects.toThrow()
      await connection.journal.append(newer, {
        kind: 'disposition',
        status: 'ignored',
      })
      const native = f.transactions
        .flatMap((t) => t.records)
        .filter((r) => r.source.wireOrdinal === 3)
      expect(native).toHaveLength(1)
      expect(native[0]?.owner).toEqual(old)
      expect(native[0]?.value).toEqual({
        kind: 'disposition',
        status: 'ignored',
      })
    } finally {
      await connection?.close()
      await f.cleanup()
    }
  })
  it('does not reserve call capacity for invalid owners or failed synchronous admission', async () => {
    const f = await setup('normal')
    f.options.host = new AcpResourceHost({ calls: [1, 1] })
    let connection: AcpConnection | undefined
    try {
      connection = await AcpConnection.open(f.options, session, false)
      const reserve = vi.spyOn(f.options.host, 'reserve')
      const invalid = Object.defineProperty({}, 'phase', {
        get() {
          throw Error('getter')
        },
      }) as AcpRecordOwner
      expect(() => connection!.call('test', {}, invalid)).toThrow()
      expect(reserve.mock.calls.some(([, kind]) => kind === 'calls')).toBe(
        false,
      )
      const request = vi
        .spyOn(connection.rpc, 'requestWithSubmission')
        .mockImplementation(() => {
          throw Error('admission')
        })
      expect(() => connection!.call('test', {}, connection!.control)).toThrow(
        'admission',
      )
      request.mockRestore()
      for (let i = 0; i < 64; i++) f.options.host.reserve('instance', 'calls')()
    } finally {
      vi.restoreAllMocks()
      await connection?.close()
      await f.cleanup()
    }
  })
  it('closes an invalid writer before releasing its original opening lease', async () => {
    const f = await setup('normal')
    const closeEntered = deferred<void>(),
      close = deferred<void>()
    const valid = await f.options.ingestion.open(
      {
        sessionId: 'session',
        providerInstanceId: 'instance',
        account: { kind: 'native-default', configurationId: 'config' },
        expectedBinding: null,
      },
      new AbortController().signal,
    )
    f.options.host = new AcpResourceHost({ commits: [1, 1] })
    f.options.ingestion.open = async () => ({
      ...valid,
      journalId: '',
      async close() {
        closeEntered.resolve()
        await close.promise
      },
    })
    const opening = AcpConnection.open(f.options, session, false)
    void opening.catch(() => {})
    try {
      await closeEntered.promise
      expect(() => f.options.host.reserve('instance', 'commits')).toThrow(
        'limit',
      )
      await expect(opening).rejects.toThrow()
      expect(() => f.options.host.reserve('instance', 'commits')).toThrow(
        'limit',
      )
      close.resolve()
      await vi.waitFor(() => f.options.host.reserve('instance', 'commits')())
    } finally {
      close.resolve()
      await opening.catch(() => {})
      await f.cleanup()
    }
  })
  it('discards the exact replay segment when load returns a native error', async () => {
    const f = await setup('normal')
    f.options.launch = {
      ...f.options.launch,
      command: process.execPath,
      args: [
        '-e',
        `
      const readline=require('node:readline');
      const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
      readline.createInterface({input:process.stdin}).on('line',line=>{
        const f=JSON.parse(line);
        if(f.method==='initialize')send({id:f.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
        else if(f.method==='session/load'){
          send({method:'session/update',params:{sessionId:f.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'replay'}}}});
          send({id:f.id,error:{code:-32000,message:'load failed'}});
        }
      });
    `,
      ],
    }
    try {
      await expect(
        AcpConnection.open(
          f.options,
          {
            ...session,
            binding: {
              provider: 'instance',
              accountId: null,
              cwd: '/var/tmp',
              providerSessionId: 'existing',
            },
          },
          true,
        ),
      ).rejects.toThrow()
      const records = f.transactions.flatMap((t) => t.records)
      const staged = records.find(
        (r) =>
          r.value.kind === 'disposition' && r.value.status === 'replay_staged',
      )
      const discarded = records.find(
        (r) =>
          r.value.kind === 'disposition' &&
          r.value.status === 'replay_discarded',
      )
      expect(staged).toBeDefined()
      expect(discarded?.owner).toEqual(staged?.owner)
      expect(discarded?.owner.phase).toBe('load_replay')
    } finally {
      await f.cleanup()
    }
  })
  it('exposes the exact native binding only after its durable prefix acknowledges it', async () => {
    const binding = deferred<void>(),
      entered = deferred<void>()
    const f = await setup('normal', async (transaction) => {
      if (
        transaction.records.some((record) => record.value.kind === 'binding')
      ) {
        entered.resolve()
        await binding.promise
      }
    })
    let connection: AcpConnection | undefined
    const opening = AcpConnection.open(f.options, session, false)
    let returned = false
    void opening.then((value) => {
      connection = value
      returned = true
    })
    try {
      await entered.promise
      expect(returned).toBe(false)
      binding.resolve()
      connection = await opening
      expect(connection.binding).toEqual({
        provider: 'instance',
        accountId: null,
        cwd: '/var/tmp',
        providerSessionId: 'fixture-session',
      })
      expect(
        connection.catalog.availableModels().map((model) => model.id),
      ).toContain('fixture-model')
    } finally {
      binding.resolve()
      await connection?.close()
      await f.cleanup()
    }
  })
  it('stages load replay under the original binding and load owner', async () => {
    const f = await setup('resume-replay')
    let connection: AcpConnection | undefined
    try {
      connection = await AcpConnection.open(
        f.options,
        {
          ...session,
          binding: {
            provider: 'instance',
            accountId: null,
            cwd: '/var/tmp',
            providerSessionId: 'existing',
          },
        },
        true,
      )
      expect(connection.binding?.providerSessionId).toBe('existing')
      expect(f.phases.length).toBeGreaterThan(0)
      expect(new Set(f.phases)).toEqual(new Set(['load_replay']))
      expect(
        f.transactions
          .flatMap((transaction) => transaction.records)
          .some(
            (record) =>
              record.value.kind === 'disposition' &&
              record.value.status === 'replay_visible',
          ),
      ).toBe(true)
    } finally {
      await connection?.close()
      await f.cleanup()
    }
  })
  it.each(['fail-init', 'fail-load', 'null-load', 'conflicting-load'])(
    'rejects %s without native new-session fallback',
    async (scenario) => {
      const f = await setup(scenario)
      try {
        await expect(
          AcpConnection.open(
            f.options,
            {
              ...session,
              binding: {
                provider: 'instance',
                accountId: null,
                cwd: '/var/tmp',
                providerSessionId: 'existing',
              },
            },
            true,
          ),
        ).rejects.toThrow()
        expect(
          f.transactions
            .flatMap((transaction) => transaction.records)
            .filter((record) => record.value.kind === 'binding'),
        ).toEqual([])
      } finally {
        await f.cleanup()
      }
    },
  )
  it('rejects affected Gemini load and mismatched bindings before starting a process', async () => {
    const f = await setup('normal')
    try {
      await expect(
        AcpConnection.open({ ...f.options, profile: 'gemini' }, session, true),
      ).rejects.toThrow('load_replay_unsupported')
      await expect(
        AcpConnection.open(
          f.options,
          {
            ...session,
            binding: {
              provider: 'other',
              accountId: null,
              cwd: '/var/tmp',
              providerSessionId: 'existing',
            },
          },
          true,
        ),
      ).rejects.toThrow('binding differs')
      expect(f.transactions).toEqual([])
    } finally {
      await f.cleanup()
    }
  })
  it('retains a timed-out writer opener through its late owned close', async () => {
    const f = await setup('normal')
    const host = new AcpResourceHost({ commits: [1, 1] })
    const entered = deferred<void>(),
      openingWriter = deferred<AcpSessionWriter>(),
      closeEntered = deferred<void>(),
      closingWriter = deferred<void>(),
      released = deferred<void>()
    const reserve = host.reserve.bind(host)
    vi.spyOn(host, 'reserve').mockImplementation((instance, kind, amount) => {
      const release = reserve(instance, kind, amount)
      return () => {
        release()
        if (kind === 'commits') released.resolve()
      }
    })
    f.options.host = host
    f.options.controlMs = 10
    f.options.ingestion = {
      open() {
        entered.resolve()
        return openingWriter.promise
      },
    }
    vi.useFakeTimers()
    try {
      const opening = AcpConnection.open(f.options, session, false)
      void opening.catch(() => {})
      await entered.promise
      await vi.advanceTimersByTimeAsync(10)
      await expect(opening).rejects.toThrow('writer opening timed out')
      expect(() => reserve('instance', 'commits')).toThrow('limit')
      openingWriter.resolve({
        journalId: 'journal',
        writerEpoch: 'epoch',
        committedThrough: 0,
        prefixHash: emptyPrefix('journal'),
        async commit(transaction) {
          return {
            transactionId: transaction.transactionId,
            throughOrdinal: transaction.throughOrdinal,
            prefixHash: committedPrefix(transaction),
          }
        },
        async close() {
          closeEntered.resolve()
          await closingWriter.promise
        },
      })
      await closeEntered.promise
      expect(() => reserve('instance', 'commits')).toThrow('limit')
      closingWriter.resolve()
      await released.promise
      reserve('instance', 'commits')()
    } finally {
      closingWriter.resolve()
      vi.useRealTimers()
      vi.restoreAllMocks()
      await f.cleanup()
    }
  })
})

it('replaces only the transport while retaining the writer, public generation, and exact session', async () => {
  const f = await setup('normal')
  const open = f.options.ingestion.open.bind(f.options.ingestion)
  const closeWriter = vi.fn(async () => {})
  const openWriter = vi.fn(async (...args: Parameters<typeof open>) => ({
    ...(await open(...args)),
    close: closeWriter,
  }))
  f.options.ingestion.open = openWriter
  const failures = vi.fn()
  f.options.failure = failures
  const generations: string[] = []
  f.options.prepareClient = async (connection) => {
    generations.push(connection.transportGeneration)
    return {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    }
  }
  let connection: AcpConnection | undefined
  try {
    connection = await AcpConnection.open(f.options, session, false)
    const journal = connection.journal,
      generation = connection.generation,
      binding = connection.binding
    const pid = connection.process.child.pid!
    const transport = connection.transportGeneration
    const replaced = await connection.replace('yolo')
    expect(replaced).toBe(connection)
    expect(connection.journal).toBe(journal)
    expect(connection.generation).toBe(generation)
    expect(connection.binding).toEqual(binding)
    expect(connection.transportGeneration).not.toBe(transport)
    expect(connection.rpc).toBe(replaced.rpc)
    await expectStopped(pid)
    expect(openWriter).toHaveBeenCalledTimes(1)
    expect(closeWriter).not.toHaveBeenCalled()
    expect(failures).not.toHaveBeenCalled()
    expect(generations).toEqual([transport, connection.transportGeneration])
    const records = f.transactions.flatMap((transaction) => transaction.records)
    expect(
      new Set(records.map((record) => record.owner.runtimeGeneration)),
    ).toEqual(new Set([generation]))
    expect(
      new Set(
        records
          .filter((record) => record.source.kind === 'native')
          .map((record) => record.source.transportGeneration),
      ),
    ).toEqual(new Set(generations))
    expect(
      f.transactions.every(
        (transaction, index) =>
          !index ||
          transaction.afterOrdinal ===
            f.transactions[index - 1]!.throughOrdinal,
      ),
    ).toBe(true)
  } finally {
    await connection?.close()
    await f.cleanup()
  }
  expect(closeWriter).toHaveBeenCalledTimes(1)
})

it('failed exact-load replacement leaves its original journal open and never opens another writer', async () => {
  const f = await setup('fail-load')
  const open = f.options.ingestion.open.bind(f.options.ingestion)
  const closeWriter = vi.fn(async () => {})
  const openWriter = vi.fn(async (...args: Parameters<typeof open>) => ({
    ...(await open(...args)),
    close: closeWriter,
  }))
  f.options.ingestion.open = openWriter
  let connection: AcpConnection | undefined
  try {
    connection = await AcpConnection.open(f.options, session, false)
    const journal = connection.journal,
      generation = connection.generation
    await expect(connection.replace('manual')).rejects.toThrow()
    expect(connection.journal).toBe(journal)
    expect(connection.generation).toBe(generation)
    expect(openWriter).toHaveBeenCalledTimes(1)
    expect(closeWriter).not.toHaveBeenCalled()
    await journal.append(connection.control, {
      kind: 'disposition',
      status: 'ignored',
    })
    const release = f.options.host.reserve('instance', 'processes', 8)
    release()
  } finally {
    await connection?.close()
    await f.cleanup()
  }
  expect(closeWriter).toHaveBeenCalledTimes(1)
})

it('replacement refuses to create another process until the original physical cleanup succeeds', async () => {
  const f = await setup('normal')
  let connection: AcpConnection | undefined
  try {
    connection = await AcpConnection.open(f.options, session, false)
    const original = connection.process,
      close = original.close.bind(original)
    const refused = vi
      .spyOn(original, 'close')
      .mockRejectedValueOnce(Error('original cleanup refused'))
      .mockImplementation(close)
    await expect(connection.replace('yolo')).rejects.toThrow(
      'original cleanup refused',
    )
    expect(connection.process).toBe(original)
    expect(() => f.options.host.reserve('instance', 'processes', 8)).toThrow(
      'resource limit',
    )
    expect(refused).toHaveBeenCalledTimes(1)
    await connection.replace('yolo')
    expect(connection.process).not.toBe(original)
    await expectStopped(original.child.pid!)
  } finally {
    await connection?.close()
    await f.cleanup()
  }
})

it('retains a failed replacement process cleanup without closing the shared writer', async () => {
  const f = await setup('fail-load')
  const open = f.options.ingestion.open.bind(f.options.ingestion)
  const closeWriter = vi.fn(async () => {})
  f.options.ingestion.open = async (...args) => ({
    ...(await open(...args)),
    close: closeWriter,
  })
  let connection: AcpConnection | undefined
  let rejectCleanup = true
  let close: { mockRestore(): void } | undefined
  try {
    connection = await AcpConnection.open(f.options, session, false)
    const original = connection.process,
      originalClose = NativeProcess.prototype.close
    close = vi
      .spyOn(NativeProcess.prototype, 'close')
      .mockImplementation(function (this: NativeProcess, reason?: Error) {
        if (this !== original && rejectCleanup)
          return Promise.reject(Error('candidate cleanup refused'))
        return originalClose.call(this, reason)
      })
    await expect(connection.replace('manual')).rejects.toThrow(
      'candidate cleanup refused',
    )
    expect(connection.process).not.toBe(original)
    await expectStopped(original.child.pid!)
    expect(closeWriter).not.toHaveBeenCalled()
    expect(() => f.options.host.reserve('instance', 'processes', 8)).toThrow(
      'resource limit',
    )
    rejectCleanup = false
    await connection.retireProcess()
    const release = f.options.host.reserve('instance', 'processes', 8)
    release()
    await connection.journal.append(connection.control, {
      kind: 'disposition',
      status: 'ignored',
    })
  } finally {
    rejectCleanup = false
    await connection?.close()
    close?.mockRestore()
    await f.cleanup()
  }
  expect(closeWriter).toHaveBeenCalledTimes(1)
})
