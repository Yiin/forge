#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

// Synthetic ACP 0.14.1 peer. Report rows preserve received RPC IDs and frames.
const scenario = process.env.FORGE_ACP_TEST_SCENARIO ?? 'normal'
const scenarios = new Set([
  'normal',
  'fail-init',
  'fail-load',
  'null-load',
  'conflicting-load',
  'resume-replay',
  'permission',
  'questions',
  'hang-prompt',
  'error-prompt',
  'grok-duplicate-completion',
  'grok-unknown-completion',
])
if (!scenarios.has(scenario))
  throw Error(`Unknown fixture scenario: ${scenario}`)
const reportPath = process.env.FORGE_ACP_TEST_REPORT
function report(event, extra = {}) {
  if (reportPath)
    appendFileSync(
      reportPath,
      `${JSON.stringify({ event, pid: process.pid, ...extra })}\n`,
    )
}
function send(frame) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
}
const reply = (id, result) => send({ id, result })
const error = (id, code, message) => send({ id, error: { code, message } })
const notify = (method, params) => send({ method, params })
let sessionId
let sessionCount = 0
let turnCount = 0
let active
const callbacks = new Map()
const configOptions = [
  {
    id: 'model',
    name: 'Model',
    type: 'select',
    category: 'model',
    currentValue: 'fixture-model',
    options: [
      { value: 'fixture-model', name: 'Fixture Model' },
      { value: 'fixture-model/low', name: 'Fixture Model Low' },
    ],
  },
]
const modes = {
  currentModeId: 'default',
  availableModes: [
    { id: 'default', name: 'Default', description: 'Ask before changes' },
    { id: 'autoEdit', name: 'Auto Edit', description: 'Allow file edits' },
    { id: 'plan', name: 'Plan', description: 'Plan without changes' },
  ],
}
const models = {
  currentModelId: 'fixture-model',
  availableModels: configOptions[0].options.map(({ value, name }) => ({
    modelId: value,
    name,
  })),
}
const catalog = () => ({ configOptions, modes, models })
const update = (value) => notify('session/update', { sessionId, update: value })
function finish(stopReason = 'end_turn') {
  if (!active) return
  const { id } = active
  active = undefined
  callbacks.clear()
  reply(id, {
    stopReason,
    usage: { totalTokens: 10, inputTokens: 4, outputTokens: 6 },
  })
}
function output() {
  update({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'Thinking.' },
  })
  update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Hello.' },
  })
  const toolCallId = `tool-${turnCount}`
  update({
    sessionUpdate: 'tool_call',
    toolCallId,
    title: 'Fixture tool',
    kind: 'read',
    status: 'in_progress',
    rawInput: { path: 'fixture.txt' },
  })
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'completed',
    rawOutput: { text: 'fixture content' },
    content: [
      { type: 'content', content: { type: 'text', text: 'fixture content' } },
    ],
  })
  update({
    sessionUpdate: 'plan',
    entries: [
      { content: 'Inspect fixture', priority: 'medium', status: 'completed' },
    ],
  })
  update({
    sessionUpdate: 'usage_update',
    used: 10,
    size: 1000,
    cost: { amount: 0, currency: 'USD' },
  })
}
function requestInteraction(kind) {
  const id = `${kind}-${turnCount}`
  const toolCallId = `tool-${turnCount}`
  callbacks.set(id, kind)
  if (kind === 'permission') {
    send({
      id,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: {
          toolCallId,
          title: 'Read fixture',
          kind: 'read',
          status: 'pending',
          rawInput: { path: 'fixture.txt' },
        },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'deny-once', name: 'Deny once', kind: 'reject_once' },
        ],
      },
    })
  } else {
    send({
      id,
      method: '_x.ai/ask_user_question',
      params: {
        sessionId,
        toolCallId,
        mode: 'default',
        questions: [
          {
            id: 'choice',
            question: 'Choose one',
            options: [
              { id: 'one', label: 'One', description: 'First choice' },
              { id: 'two', label: 'Two', description: 'Second choice' },
            ],
          },
        ],
      },
    })
  }
}
function callback(frame) {
  const kind = callbacks.get(frame.id)
  if (!kind) return
  if (frame.error) {
    finish('cancelled')
    return
  }
  const result = frame.result
  const valid =
    kind === 'permission'
      ? result?.outcome?.outcome === 'cancelled' ||
        (result?.outcome?.outcome === 'selected' &&
          ['allow-once', 'deny-once'].includes(result.outcome.optionId))
      : result?.outcome === 'cancelled' ||
        (result?.outcome === 'accepted' &&
          result.answers &&
          Object.keys(result.answers).length === 1 &&
          Array.isArray(result.answers['Choose one']) &&
          result.answers['Choose one'].length === 1 &&
          (result.answers['Choose one'][0] !== 'Other' ||
            typeof result.annotations?.['Choose one']?.notes === 'string') &&
          result.answers['Choose one'].every((answer) =>
            ['One', 'Two', 'Other'].includes(answer),
          ))
  if (!valid) {
    report('invalid_reply', { frame })
    return
  }
  const cancelled =
    kind === 'permission'
      ? result.outcome.outcome === 'cancelled'
      : result.outcome === 'cancelled'
  finish(cancelled ? 'cancelled' : 'end_turn')
}
function receive(frame) {
  report('received', { frame })
  if (!frame.method) return callback(frame)
  const p = frame.params ?? {}
  if (frame.method === 'initialize') {
    if (scenario === 'fail-init')
      return error(frame.id, -32000, 'Fixture initialization failed')
    return reply(frame.id, {
      protocolVersion: 1,
      agentInfo: { name: 'forge-acp-fixture', version: '0.14.1' },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
        sessionCapabilities: {},
      },
      authMethods: [],
    })
  }
  if (frame.method === 'session/new') {
    sessionId =
      ++sessionCount === 1
        ? 'fixture-session'
        : `fixture-session-${sessionCount}`
    return reply(frame.id, { sessionId, ...catalog() })
  }
  if (frame.method === 'session/load') {
    if (scenario === 'fail-load')
      return error(frame.id, -32000, 'Fixture resume failed')
    if (scenario === 'null-load') return reply(frame.id, null)
    sessionId = p.sessionId
    if (scenario === 'resume-replay') {
      update({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Earlier question' },
      })
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Earlier answer' },
      })
    }
    return reply(frame.id, {
      ...catalog(),
      ...(scenario === 'conflicting-load'
        ? { sessionId: 'foreign-session' }
        : {}),
    })
  }
  if (p.sessionId !== sessionId || !sessionId) {
    if ('id' in frame) error(frame.id, -32602, 'Unknown fixture session')
    return
  }
  if (frame.method === 'session/prompt') {
    if (active) return error(frame.id, -32000, 'Fixture prompt already active')
    if (scenario === 'error-prompt')
      return error(frame.id, -32000, 'Fixture prompt failed')
    if (
      scenario.startsWith('grok-') &&
      (typeof p._meta?.promptId !== 'string' || !p._meta.promptId.length)
    )
      return error(frame.id, -32602, 'Grok fixture requires a prompt ID')
    active = { id: frame.id, promptId: p._meta?.promptId }
    turnCount++
    output()
    if (scenario === 'permission' || scenario === 'questions')
      return requestInteraction(scenario)
    if (scenario === 'hang-prompt') return
    if (scenario.startsWith('grok-')) {
      const params = {
        sessionId,
        promptId:
          scenario === 'grok-unknown-completion'
            ? 'unowned-prompt'
            : active.promptId,
        stopReason: 'end_turn',
      }
      notify('_x.ai/session/prompt_complete', params)
      if (scenario === 'grok-unknown-completion') return
      notify('_x.ai/session/prompt_complete', params)
    }
    return finish()
  }
  if (frame.method === 'session/cancel') {
    finish('cancelled')
    if ('id' in frame) reply(frame.id, {})
    return
  }
  if (frame.method === 'session/set_config_option') {
    const option = configOptions.find((entry) => entry.id === p.configId)
    if (!option?.options.some((entry) => entry.value === p.value))
      return error(frame.id, -32602, 'Unknown fixture config value')
    option.currentValue = p.value
    update({ sessionUpdate: 'config_option_update', configOptions })
    return reply(frame.id, { configOptions })
  }
  if (frame.method === 'session/set_model') {
    if (!models.availableModels.some((entry) => entry.modelId === p.modelId))
      return error(frame.id, -32602, 'Unknown fixture model')
    models.currentModelId = p.modelId
    return reply(frame.id, {})
  }
  if (frame.method === 'session/set_mode') {
    if (!modes.availableModes.some((entry) => entry.id === p.modeId))
      return error(frame.id, -32602, 'Unknown fixture mode')
    modes.currentModeId = p.modeId
    update({ sessionUpdate: 'current_mode_update', currentModeId: p.modeId })
    return reply(frame.id, {})
  }
  if ('id' in frame) error(frame.id, -32601, 'Unsupported fixture method')
}
report('spawned')
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    error(null, -32700, 'Invalid JSON')
    return
  }
  receive(frame)
})
lines.on('close', () => {
  callbacks.clear()
  active = undefined
  report('eof')
})
