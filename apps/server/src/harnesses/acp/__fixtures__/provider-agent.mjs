#!/usr/bin/env node
import { appendFileSync, existsSync, watch } from 'node:fs'
import { dirname, basename } from 'node:path'
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
      if (scenario === 'grok-responses') {
        const update = (value) =>
          send({
            method: 'session/update',
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
      reply(frame.id, { stopReason: 'end_turn' })
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
