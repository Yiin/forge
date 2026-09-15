#!/usr/bin/env node
import { appendFileSync, existsSync, watch } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { createInterface } from 'node:readline'

// A synthetic peer. File gates control advertisements without provider access.
const reportPath = process.env.FORGE_ACP_TEST_REPORT
const gate = process.env.FORGE_ACP_TEST_MODEL_GATE
const scenario = process.env.FORGE_ACP_TEST_SCENARIO
const sessionId = 'provider-session'
const effortId = 'model-uid/reasoning-high'
const report = (event, extra = {}) =>
  appendFileSync(
    reportPath,
    JSON.stringify({ event, pid: process.pid, ...extra }) + '\n',
  )
const send = (frame) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
const reply = (id, result) => send({ id, result })
let watcher
let retirementTurn = 0
const retirementChildren = new Map()
let advertised = false
let currentModeId = 'default'
const modes = () => ({
  currentModeId,
  availableModes: ['default', 'autoEdit', 'yolo', 'plan'].map((id) => ({
    id,
    name: id,
  })),
})
const configOptions = [
  {
    id: 'native-model',
    name: 'Model',
    type: 'select',
    category: 'model',
    currentValue: 'model-uid',
    options: [
      { value: 'model-uid', name: 'Model' },
      { value: effortId, name: 'High reasoning' },
    ],
  },
]
function advertise() {
  if (advertised || !existsSync(gate)) return
  advertised = true
  watcher.close()
  report('advertised', { effortId })
  send({
    method: 'session/update',
    params: {
      sessionId,
      update: { sessionUpdate: 'config_option_update', configOptions },
    },
  })
}
report('spawned', { args: process.argv.slice(2) })
const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  const frame = JSON.parse(line)
  report('received', { frame })
  switch (frame.method) {
    case 'initialize':
      reply(frame.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [],
      })
      break
    case 'session/new':
    case 'session/load':
      if (scenario === 'devin-advertisement' && !watcher) {
        watcher = watch(dirname(gate), (_event, name) => {
          if (name === basename(gate)) advertise()
        })
        report('awaiting_advertisement')
      }
      reply(frame.id, {
        sessionId,
        ...(scenario === 'gemini-modes' ? { modes: modes() } : {}),
      })
      break
    case 'session/prompt':
      if (scenario === 'late-child-retirement') {
        const turn = ++retirementTurn
        const child = {
          subagent_id: `child-${turn}`,
          child_session_id: `child-session-${turn}`,
          attempt_id: `attempt-${turn}`,
          parent_prompt_id: frame.params._meta.promptId,
        }
        retirementChildren.set(`finish-child-${turn}`, child)
        const native = (update) =>
          send({
            method: '_x.ai/session/update',
            params: { sessionId, update },
          })
        if (!watcher)
          watcher = watch(dirname(reportPath), (_event, name) => {
            const pending = retirementChildren.get(name)
            if (pending && existsSync(join(dirname(reportPath), name))) {
              retirementChildren.delete(name)
              send({
                method: 'session/update',
                params: {
                  sessionId: pending.child_session_id,
                  update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: {
                      type: 'text',
                      text: `Late ${pending.subagent_id}.`,
                    },
                    _meta: { attempt_id: pending.attempt_id },
                  },
                },
              })
              native({
                sessionUpdate: 'subagent_finished',
                ...pending,
                status: 'completed',
                tool_calls: 0,
                turns: 1,
                duration_ms: 1,
              })
              report('child_finish_sent', { child: pending.subagent_id })
            }
            if (
              name === 'late-response' &&
              !advertised &&
              existsSync(join(dirname(reportPath), name))
            ) {
              advertised = true
              native({
                sessionUpdate: 'response_completed',
                message_id: 'response-1',
                stop_reason: 'end_turn',
                usage: { output_tokens: 99 },
              })
              report('late_response_sent')
            }
          })
        native({
          sessionUpdate: 'response_started',
          message_id: `response-${turn}`,
          input_tokens: turn,
        })
        send({
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Root ${turn}.` },
            },
          },
        })
        native({
          sessionUpdate: 'subagent_spawned',
          ...child,
          subagent_type: 'general',
          parent_session_id: sessionId,
          description: `Child ${turn}`,
        })
        native({
          sessionUpdate: 'response_completed',
          message_id: `response-${turn}`,
          stop_reason: 'end_turn',
          usage: { output_tokens: turn },
        })
        reply(frame.id, { stopReason: 'end_turn' })
        break
      }

      if (scenario === 'grok-completion') {
        const completionCase = process.env.FORGE_ACP_TEST_COMPLETION
        const rail = process.env.FORGE_ACP_TEST_RAIL
        const replyGate = process.env.FORGE_ACP_TEST_REPLY_GATE
        const correlation =
          completionCase === 'missing'
            ? undefined
            : completionCase === 'foreign-prompt'
              ? 'unowned-prompt'
              : frame.params._meta.promptId
        const nativeSession =
          completionCase === 'foreign-session' ? 'foreign-session' : sessionId
        const stopReason = completionCase === 'error' ? 'error' : 'end_turn'
        const completion =
          rail === 'public'
            ? {
                method: '_x.ai/session/update',
                params: {
                  sessionId: nativeSession,
                  update: {
                    sessionUpdate: 'turn_completed',
                    prompt_id: correlation,
                    stop_reason: stopReason,
                  },
                },
              }
            : {
                method: '_x.ai/session/prompt_complete',
                params: {
                  sessionId: nativeSession,
                  promptId: correlation,
                  stopReason,
                },
              }
        if (completionCase === 'response-first')
          reply(frame.id, { stopReason: 'end_turn' })
        send(completion)
        report('completion_sent', { frame: completion })
        if (
          ['missing', 'foreign-session', 'foreign-prompt'].includes(
            completionCase,
          )
        ) {
          let replied = false
          const release = () => {
            if (replied || !existsSync(replyGate)) return
            replied = true
            watcher.close()
            reply(frame.id, { stopReason: 'refusal' })
          }
          watcher = watch(dirname(replyGate), (_event, name) => {
            if (name === basename(replyGate)) release()
          })
          release()
        } else if (!['hung', 'response-first'].includes(completionCase))
          reply(frame.id, {
            stopReason: completionCase === 'error' ? 'refusal' : 'end_turn',
          })
        break
      }

      if (scenario === 'grok-responses') {
        const update = (value) =>
          send({
            method: [
              'response_started',
              'reasoning_completed',
              'response_completed',
            ].includes(value.sessionUpdate)
              ? '_x.ai/session/update'
              : 'session/update',
            params: { sessionId, update: value },
          })
        for (const [index, message_id] of [
          'native-one',
          'native-two',
        ].entries()) {
          update({
            sessionUpdate: 'response_started',
            message_id,
            input_tokens: index + 1,
          })
          update({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Response ${index + 1}.` },
          })
          update({
            sessionUpdate: 'reasoning_completed',
            signature: `signature-${index + 1}`,
          })
          update({
            sessionUpdate: 'response_completed',
            message_id,
            stop_reason: index ? 'end_turn' : 'tool_use',
            stop_sequence: `stop-${index + 1}`,
            usage: { output_tokens: index + 2 },
          })
        }
      }
      if (process.env.FORGE_ACP_TEST_STOP === 'rpc-error')
        send({
          id: frame.id,
          error: { code: -32000, message: 'Synthetic native failure' },
        })
      else
        reply(frame.id, {
          stopReason: process.env.FORGE_ACP_TEST_STOP ?? 'end_turn',
        })
      break
    case 'session/set_mode':
      if (
        scenario !== 'gemini-modes' ||
        !modes().availableModes.some((mode) => mode.id === frame.params.modeId)
      )
        throw Error('Unadvertised mode')
      currentModeId = frame.params.modeId
      report('mode_acknowledged', { modeId: currentModeId })
      reply(frame.id, {})
      break
    case 'session/set_config_option':
      if (
        !advertised ||
        frame.params.configId !== 'native-model' ||
        frame.params.value !== effortId
      )
        throw Error('Unadvertised or changed model identity')
      reply(frame.id, {
        configOptions: configOptions.map((option) => ({
          ...option,
          currentValue: effortId,
        })),
      })
      break
    case 'session/cancel':
      break
    default:
      if ('id' in frame)
        send({
          id: frame.id,
          error: { code: -32601, message: 'Unknown fixture method' },
        })
  }
})
input.on('close', () => {
  watcher?.close()
})
