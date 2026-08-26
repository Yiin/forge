import { describe, expect, it } from 'vitest'
import { Ephemeral } from '../src/events.js'
import { makeId, idSchemas } from '../src/ids.js'
import { MessageContent, messageContentTypes } from '../src/message.js'
import { StatusEvent } from '../src/status.js'

const fixtures = [
  { type: 'text_delta', text: 'hello' },
  { type: 'thought_delta', text: 'thinking' },
  {
    type: 'tool_call',
    toolCallId: 'tool-1',
    name: 'read',
    input: { path: 'README.md' },
  },
  { type: 'tool_update', toolCallId: 'tool-1', status: 'running' },
  { type: 'tool_result', toolCallId: 'tool-1', output: 'done', isError: false },
  {
    type: 'ask_user_question',
    questionId: 'question-1',
    question: 'Continue?',
  },
  { type: 'user_answer', questionId: 'question-1', answer: 'yes' },
  {
    type: 'attachment_ref',
    attachmentId: 'att-1',
    path: 'files/att-1.txt',
    filename: 'notes.txt',
  },
  { type: 'turn_start' },
  { type: 'turn_end' },
  { type: 'turn_interrupted', reason: 'server restart' },
  { type: 'error', message: 'failed', code: 'E_FAIL' },
  {
    type: 'epic_triage',
    runId: 'run-1',
    beadId: 'bead-1',
    attempts: 2,
    classification: 'code',
    failureChain: [
      { attempt: 1, signature: 'sig-1', excerpt: 'typecheck failed' },
    ],
  },
] as const

describe('protocol schemas', () => {
  it('round-trips every message content variant', () => {
    for (const fixture of fixtures)
      expect(MessageContent.parse(fixture)).toEqual(fixture)
  })
  it('keeps the type list exhaustive', () => {
    expect(new Set(messageContentTypes)).toEqual(
      new Set(fixtures.map(({ type }) => type)),
    )
  })
  it('round-trips every ephemeral variant', () => {
    const events = [
      {
        type: 'uploadProgress',
        seq: null,
        attachmentId: 'att-1',
        sessionId: 'ses-1',
        bytesReceived: 5,
        sizeBytes: 10,
      },
      {
        type: 'sessionStatus',
        seq: null,
        sessionId: 'ses-1',
        status: 'running',
      },
      { type: 'epicRunStatus', seq: null, runId: 'run-1', status: 'paused' },
      { type: 'presence', seq: null, sessionId: 'ses-1', connected: true },
    ] as const
    for (const event of events) expect(Ephemeral.parse(event)).toEqual(event)
  })
  it('creates and validates prefixed ULIDs', () => {
    for (const kind of ['prj', 'ses', 'att', 'run', 'itr'] as const)
      expect(idSchemas[kind].parse(makeId(kind))).toBeTypeOf('string')
  })
  it('parses dashboard event variants', () => {
    const status = {
      version: 'dev',
      bootId: 'boot',
      uptimeSec: 1,
      projects: 1,
      sessions: { idle: 0, running: 1, errored: 0 },
      epicRuns: { running: 0, paused: 0 },
      harnesses: [],
      dataDirBytes: 0,
    }
    expect(StatusEvent.parse({ type: 'snapshot', status })).toEqual({
      type: 'snapshot',
      status,
    })
    expect(
      StatusEvent.parse({ type: 'heartbeat', ts: new Date().toISOString() })
        .type,
    ).toBe('heartbeat')
  })
})
