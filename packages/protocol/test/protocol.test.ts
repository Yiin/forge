import { describe, expect, it } from 'vitest'
import { Ephemeral } from '../src/events.js'
import { makeId, idSchemas } from '../src/ids.js'
import { MessageContent, messageContentTypes } from '../src/message.js'
import { StatusEvent } from '../src/status.js'
import {
  harnessEventSchema,
  questionRequestSchema,
  dispatchOptionsSchema,
  permissionRequestSchema,
  questionAnswerSchema,
} from '../src/harness.js'

// Passthrough content types carry the harness event itself, minus the turnId and
// itemId the session manager strips before it appends the message. Their
// fixtures therefore have to stay valid harness events, so `passthroughFixtures`
// is checked against `harnessEventSchema` below.
const runEnvelope = {
  runId: 'run-1',
  runtimeGeneration: 'generation-1',
  deliveryId: 'delivery-1',
} as const
const turnItemEnvelope = {
  ...runEnvelope,
  turnId: 'turn-1',
  itemId: 'item-1',
} as const
const sourceRef = {
  artifactId: 'artifact-1',
  mime: 'application/json',
  bytes: 24,
  sha256: 'a'.repeat(64),
} as const
const passthroughFixtures = [
  {
    ...turnItemEnvelope,
    type: 'content_snapshot',
    contentType: 'text',
    role: 'assistant',
    text: 'Authoritative response',
  },
  {
    ...turnItemEnvelope,
    type: 'content_block',
    blockIndex: 0,
    role: 'assistant',
    block: {
      kind: 'text_resource',
      uri: 'file:///repo/README.md',
      mime: 'text/markdown',
      text: '# Forge',
    },
    sourceRef,
  },
  {
    ...runEnvelope,
    turnId: 'turn-1',
    type: 'source_reference',
    subject: { kind: 'item', itemId: 'item-1' },
    boundary: 'closed',
    sourceRef,
  },
  {
    ...turnItemEnvelope,
    type: 'usage',
    inputTokens: 120,
    outputTokens: 34,
    totalTokens: 154,
    modelContextWindow: 200000,
  },
  {
    ...turnItemEnvelope,
    type: 'usage_snapshot',
    measurementId: 'measurement-1',
    responseId: 'response-1',
    inputTokenBasis: 'excludes_cache_reads',
    tokenScope: 'call',
    tokens: { inputTokens: 120, outputTokens: 34 },
    context: { used: 154, capacity: 200000 },
  },
  {
    ...turnItemEnvelope,
    type: 'file_change',
    path: 'apps/server/src/index.ts',
    kind: 'modified',
  },
  {
    ...turnItemEnvelope,
    type: 'child_updated',
    childId: 'child-1',
    parentToolCallId: 'tool-1',
    providerChildId: 'agent-7',
  },
] as const

const fixtures = [
  ...passthroughFixtures,
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
    type: 'plan',
    explanation: 'Land the merge',
    steps: [
      { id: 'step-1', title: 'Merge main', status: 'completed' },
      { id: 'step-2', title: 'Fix the gate', status: 'running' },
    ],
  },
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
  it('retains native event identity and delivery envelope fields', () => {
    const event = {
      type: 'text_delta',
      runId: 'run-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      text: 'hi',
      runtimeGeneration: 'generation-1',
      deliveryId: 'delivery-1',
      providerRunId: 'native-run',
      providerTurnId: 'native-turn',
      providerItemId: 'native-item',
    }
    expect(harnessEventSchema.parse(event)).toEqual(event)
  })

  it('preserves free-input question rules and typed answer semantics', () => {
    const request = {
      requestId: 'request-1',
      questions: [
        {
          id: 'question-1',
          question: 'What next?',
          options: [],
          multiSelect: false,
          allowFreeInput: true,
        },
      ],
    }
    expect(questionRequestSchema.parse(request)).toEqual(request)
  })
  it('rejects malformed native identities and retains provider policy details', () => {
    expect(
      harnessEventSchema.safeParse({
        type: 'text_delta',
        runId: 123,
        runtimeGeneration: [],
        deliveryId: {},
        turnId: 't',
        itemId: 'i',
        text: 'x',
      }).success,
    ).toBe(false)
    expect(
      dispatchOptionsSchema.parse({
        model: 'm',
        approvalPolicy: 'untrusted',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: ['/repo'],
          networkAccess: false,
        },
        serviceTier: 'priority',
      }),
    ).toMatchObject({ approvalPolicy: 'untrusted', serviceTier: 'priority' })
    expect(
      permissionRequestSchema.parse({
        requestId: 'p',
        toolCallId: null,
        title: 'Network',
        options: [],
        permissions: { network: { enabled: true } },
        scope: 'turn',
        approvalId: 'a',
        kind: 'writeStdin',
      }),
    ).toMatchObject({ scope: 'turn', kind: 'writeStdin' })
    expect(
      questionAnswerSchema.parse({
        type: 'selected_with_text',
        optionIds: ['o'],
        text: 'other',
      }),
    ).toEqual({ type: 'selected_with_text', optionIds: ['o'], text: 'other' })
  })

  it('round-trips every message content variant', () => {
    for (const fixture of fixtures)
      expect(MessageContent.parse(fixture)).toEqual(fixture)
  })
  it('keeps the type list exhaustive', () => {
    expect(new Set(messageContentTypes)).toEqual(
      new Set(fixtures.map(({ type }) => type)),
    )
  })
  it('keeps passthrough content valid as harness events', () => {
    for (const fixture of passthroughFixtures)
      expect(harnessEventSchema.parse(fixture)).toEqual(fixture)
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
  it('validates context window usage bounds', () => {
    const usage = {
      usedTokens: 10,
      maxTokens: 100,
      source: 'claude.transcript',
      observedAt: 1,
    }
    expect(
      Ephemeral.safeParse({
        type: 'contextWindow',
        seq: null,
        sessionId: 'ses-1',
        usage,
      }).success,
    ).toBe(true)
    expect(
      Ephemeral.safeParse({
        type: 'contextWindow',
        seq: null,
        sessionId: 'ses-1',
        usage: { ...usage, usedTokens: -1 },
      }).success,
    ).toBe(false)
    expect(
      Ephemeral.safeParse({
        type: 'contextWindow',
        seq: null,
        sessionId: 'ses-1',
        usage: { ...usage, maxTokens: 0 },
      }).success,
    ).toBe(false)
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
