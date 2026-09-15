#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'

// The installed SDK owns parsing, validation, request IDs, and dispatch.
const scenario = process.env.FORGE_ACP_TEST_SCENARIO ?? 'normal'
if (
  !['normal', 'permission', 'hang-prompt', 'resume-replay'].includes(scenario)
)
  throw Error(`Unknown SDK fixture scenario: ${scenario}`)
const reportPath = process.env.FORGE_ACP_TEST_REPORT
function report(event, extra = {}) {
  if (reportPath)
    appendFileSync(
      reportPath,
      `${JSON.stringify({ event, pid: process.pid, ...extra })}\n`,
    )
}
const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
)
stream.readable = stream.readable.pipeThrough(
  new TransformStream({
    transform(frame, controller) {
      report('received', { frame })
      controller.enqueue(frame)
    },
  }),
)
const sessions = new Map()
let sessionCount = 0
const modes = {
  currentModeId: 'default',
  availableModes: [
    { id: 'default', name: 'Default' },
    { id: 'plan', name: 'Plan' },
  ],
}
function session(id) {
  const value = sessions.get(id)
  if (!value) throw Error('Unknown fixture session')
  return value
}
function createSession(id) {
  sessions.set(id, { active: undefined, turn: 0 })
  return { sessionId: id, modes: structuredClone(modes) }
}
const connection = new AgentSideConnection(
  (client) => ({
    async initialize() {
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'forge-sdk-fixture', version: '0.14.1' },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: {
            image: true,
            audio: true,
            embeddedContext: true,
          },
        },
        authMethods: [],
      }
    },
    async authenticate() {
      throw Error('Fixture authentication is unavailable')
    },
    async newSession() {
      sessionCount += 1
      return createSession(`sdk-session-${sessionCount}`)
    },
    async loadSession({ sessionId }) {
      createSession(sessionId)
      if (scenario === 'resume-replay') {
        for (let index = 0; index < 70; index += 1)
          await client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `History ${index}.` },
            },
          })
      }
      return { modes: structuredClone(modes) }
    },
    async setSessionMode({ sessionId, modeId }) {
      session(sessionId)
      if (!modes.availableModes.some((mode) => mode.id === modeId))
        throw Error('Unknown fixture mode')
      await client.sessionUpdate({
        sessionId,
        update: { sessionUpdate: 'current_mode_update', currentModeId: modeId },
      })
      return {}
    },
    async prompt({ sessionId }) {
      const owner = session(sessionId)
      if (owner.active) throw Error('Overlapping fixture prompt')
      const completion = Promise.withResolvers()
      const active = { completion, cancelled: false }
      owner.active = active
      owner.turn += 1
      try {
        if (scenario === 'hang-prompt') return await completion.promise
        if (scenario === 'permission') {
          const permission = client.requestPermission({
            sessionId,
            toolCall: {
              toolCallId: `sdk-tool-${owner.turn}`,
              title: 'Read fixture',
              kind: 'read',
              status: 'pending',
            },
            options: [
              {
                optionId: 'allow-once',
                name: 'Allow once',
                kind: 'allow_once',
              },
              { optionId: 'deny-once', name: 'Deny once', kind: 'reject_once' },
            ],
          })
          void permission.catch(() => {})
          const selected = await Promise.race([
            permission.then((result) => ({ kind: 'permission', result })),
            completion.promise.then((result) => ({
              kind: 'completion',
              result,
            })),
          ])
          if (selected.kind === 'completion') return selected.result
          const result = selected.result
          report('permission', { result })
          if (active.cancelled || result.outcome.outcome === 'cancelled')
            return { stopReason: 'cancelled' }
          if (result.outcome.optionId !== 'allow-once')
            return { stopReason: 'refusal' }
        }
        if (active.cancelled) return { stopReason: 'cancelled' }
        await client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Hello from SDK.' },
          },
        })
        return { stopReason: active.cancelled ? 'cancelled' : 'end_turn' }
      } finally {
        if (owner.active === active) owner.active = undefined
      }
    },
    async cancel({ sessionId }) {
      const active = session(sessionId).active
      if (!active) return
      active.cancelled = true
      active.completion.resolve({ stopReason: 'cancelled' })
    },
  }),
  stream,
)
report('spawned')
await connection.closed
report('eof')
