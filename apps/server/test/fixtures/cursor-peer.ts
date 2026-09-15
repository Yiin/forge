import { createHash } from 'node:crypto'
import { CursorFixtureStore } from './cursor-store.js'
import type * as SDK from '@cursor/sdk'
import { CursorSidecarRuntime } from '../../src/harnesses/cursor/sidecar-runtime.js'
import { cursorTransport } from '../../src/harnesses/cursor/wire.js'
import {
  cursorLimits,
  CursorResources,
} from '../../src/harnesses/cursor/limits.js'
import type {
  CursorSelectedRecords,
  CursorOwner,
  CursorReservation,
} from '../../src/harnesses/cursor/contracts.js'
const limits = cursorLimits(),
  managed = ['--managed-probe', '--managed'].includes(process.argv[2]),
  generation = process.argv[managed ? 3 : 2],
  nonce = managed ? process.argv[4] : undefined
let scenario = '',
  releaseGate = () => {}
const gate = new Promise<void>((resolve) => {
  releaseGate = resolve
})
process.on('SIGUSR1', () => releaseGate())
async function holdPhase(phase: string) {
  if (scenario === `hold-${phase}`) {
    process.stderr.write(`fixture:${phase}\n`)
    await gate
  }
}
let count = 0
const fake = {
  JsonlLocalAgentStore: CursorFixtureStore,
  Cursor: {
    me: async (options: { apiKey: string }) => {
      await holdPhase('metadata')
      if (options.apiKey !== (scenario === 'short-key' ? 't' : 'synthetic-key'))
        throw new Error('fixture explicit key mismatch')
      if (scenario === 'metadata-error')
        throw new Error('fixture metadata failed')
      return {}
    },
    models: {
      list: async () => {
        await holdPhase('models')
        if (scenario === 'catalog-error')
          throw new Error('fixture catalog failed')
        return [
          {
            id: 'test',
            displayName: 'Test',
            aliases: ['alias'],
            parameters: [
              { id: 'effort', values: [{ value: 'low' }, { value: 'high' }] },
            ],
          },
        ]
      },
    },
  },
  InteractionUpdateSchema: { parse: (value: unknown) => value },
  ConversationStepSchema: { parse: (value: unknown) => value },
  Agent: {
    create: async (options: SDK.AgentOptions) => {
      await holdPhase('create')
      const store = options.local!.store!,
        now = Date.now(),
        id = `agent-${createHash('sha256')
          .update((store as unknown as { directory: string }).directory)
          .digest('hex')
          .slice(0, 16)}-${++count}`,
        runId = `native-${count}-1`
      const agent: SDK.LocalAgentDocument = {
        agentId: id,
        cwd: options.local!.cwd!,
        createdAt: now,
        updatedAt: now,
        status: 'idle',
        activeRunId: null,
        sdkMetadata: { key: 'unchanged' },
      }
      await store.agents.create({ agent })
      if (scenario === 'crash-create') process.kill(process.pid, 'SIGKILL')
      await store.runs.create({
        run: {
          agentId: id,
          runId,
          turnNumber: 1,
          status: 'queued',
          createdAt: now,
          updatedAt: now,
        },
      })
      await store.agents.update({ agent: { ...agent, activeRunId: runId } })
      return agentHandle(id, store)
    },
    resume: async (id: string, options: SDK.AgentOptions) => {
      await holdPhase('resume')
      return agentHandle(id, options.local!.store!)
    },
  },
} as unknown as typeof SDK
function agentHandle(
  agentId: string,
  store: SDK.LocalAgentStore,
): SDK.SDKAgent {
  return {
    agentId,
    model: undefined,
    close() {},
    async [Symbol.asyncDispose]() {
      if (scenario === 'dispose-error')
        throw new Error('fixture disposal failed')
    },
    async reload() {},
    async listArtifacts() {
      return []
    },
    async downloadArtifact() {
      throw new Error('unsupported')
    },
    async getUsage() {
      throw new Error('unsupported')
    },
    async send(message, options) {
      const agent = (await store.agents.get({ agentId }))!
      let active = agent.activeRunId
      if (!active) {
        const rows = await store.runs.list()
        active = `native-follow-${rows.items.length + 1}`
        const now = Date.now()
        await store.runs.create({
          run: {
            agentId,
            runId: active,
            turnNumber: rows.items.length + 1,
            status: 'queued',
            createdAt: now,
            updatedAt: now,
          },
        })
        await store.agents.update({ agent: { ...agent, activeRunId: active } })
      }
      const text = typeof message === 'string' ? message : message.text
      const maximum = scenario.startsWith('content-')
      const content = maximum
        ? (scenario.includes('escaped') ? '\u0000' : 'x').repeat(
            limits.itemBytes + (scenario.includes('overflow') ? 1 : 0),
          )
        : 'AB'
      const finalContent = scenario.includes('correction')
        ? `${content.slice(0, -1)}Z`
        : content
      const row = (await store.runs.get({ agentId, runId: active }))!
      await store.runs.update({ run: { ...row, status: 'running' } })
      if (scenario === 'crash-send') process.kill(process.pid, 'SIGKILL')
      if (maximum) {
        if (scenario.includes('append')) {
          for (let start = 0; start < content.length; start += 1024)
            await options!.onDelta?.({
              update: {
                type: 'text-delta',
                text: content.slice(start, start + 1024),
              },
            })
        }
        if (!scenario.includes('final-only'))
          await options!.onStep?.({
            step: { type: 'assistantMessage', message: { text: content } },
          })
      } else if (scenario !== 'stream-only') {
        await options!.onDelta?.({ update: { type: 'text-delta', text: 'A' } })
        await options!.onStep?.({
          step: { type: 'assistantMessage', message: { text: 'A' } },
        })
        await options!.onDelta?.({ update: { type: 'text-delta', text: 'B' } })
      }
      if (text === 'hold')
        await options!.onDelta?.({ update: { type: 'turn-ended' } as never })
      await holdPhase('send')
      let cancelled = false,
        release: () => void = () => {}
      const held =
        text === 'hold'
          ? new Promise<void>((resolve) => {
              release = resolve
            })
          : Promise.resolve()
      const finish = (async () => {
        await held
        const row = (await store.runs.get({ agentId, runId: active! }))!
        await store.runs.update({
          run: {
            ...row,
            status: cancelled ? 'cancelled' : 'finished',
            result: finalContent,
            endedAt: Date.now(),
          },
        })
        const latest = (await store.agents.get({ agentId }))!
        await store.agents.update({ agent: { ...latest, activeRunId: null } })
        return {
          id: active!,
          status: cancelled ? 'cancelled' : 'finished',
          result: finalContent,
        } as SDK.RunResult
      })()
      return {
        id: active!,
        agentId,
        status: 'running',
        supports: () => true,
        unsupportedReason: () => undefined,
        async *stream() {
          yield {
            type: 'task',
            agent_id: agentId,
            run_id: active!,
            text: 'stream-only summary',
          } satisfies SDK.SDKMessage
          if (text === 'hold')
            yield {
              type: 'status',
              agent_id: agentId,
              run_id: active!,
              status: 'FINISHED',
            } satisfies SDK.SDKMessage
          yield {
            type: 'assistant',
            agent_id: agentId,
            run_id: active!,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: finalContent }],
            },
          } satisfies SDK.SDKMessage
        },
        wait: () => finish,
        cancel: async () => {
          cancelled = true
          release()
          await finish
        },
        conversation: async () => [],
        onDidChangeStatus: () => () => {},
      }
    },
  }
}
let runtime: CursorSidecarRuntime | undefined
const transport = cursorTransport(
  process.stdout,
  process.stdin,
  generation,
  limits,
  (frame) => {
    if (
      frame.type === 'initialize' ||
      (managed && frame.type === 'container_bound' && frame.nonce === nonce)
    ) {
      scenario =
        (frame.selected as CursorSelectedRecords).accountEnv.TEST_SCENARIO ?? ''
      runtime = new CursorSidecarRuntime(
        fake,
        frame.selected as CursorSelectedRecords,
        String(frame.directory),
        frame.owner as CursorOwner,
        cursorLimits(frame.limits ?? {}),
        (value) => {
          if (value.type === 'result' && scenario === 'crash-result')
            process.kill(process.pid, 'SIGKILL')
          return (value.type === 'prepared' && scenario === 'drop-prepared') ||
            (value.type === 'submitted' && scenario === 'drop-submitted')
            ? Promise.resolve()
            : transport.send(value)
        },
        new CursorResources(),
        managed
          ? (frame.reservation as CursorReservation)?.state ===
              'creation-started'
          : frame.creating === true,
        frame.reservation as CursorReservation,
      )
      void runtime.initialize(frame).catch(() =>
        transport.send({
          v: 1,
          generation,
          type: 'failure',
          requestId: frame.requestId,
          code: 'fixture_initialize',
        }),
      )
    } else void runtime!.command(frame)
  },
)
if (managed)
  void transport.send({
    v: 1,
    generation,
    type: 'bootstrap_wait',
    nonce,
    pid: process.pid,
  })
