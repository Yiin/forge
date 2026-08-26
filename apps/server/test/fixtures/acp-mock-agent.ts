import { appendFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import * as acp from '@zed-industries/agent-client-protocol'

const env = process.env
const flag = (name: string) => env[`FORGE_MOCK_${name}`] === '1'
const numberFlag = (name: string, fallback = 0) =>
  Number(env[`FORGE_MOCK_${name}`] ?? fallback)
const requestLogPath = env.FORGE_MOCK_REQUEST_LOG_PATH
const sessionId = 'forge-mock-session'

function logRequest(method: string, params: unknown): void {
  if (requestLogPath)
    appendFileSync(requestLogPath, `${JSON.stringify({ method, params })}\n`)
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('cancelled'))
      },
      { once: true },
    )
  })
}

class MockAgent implements acp.Agent {
  private readonly active = new Map<string, AbortController>()
  private readonly connection: acp.AgentSideConnection

  constructor(connection: acp.AgentSideConnection) {
    this.connection = connection
  }

  async authenticate(
    _params: acp.AuthenticateRequest,
  ): Promise<acp.AuthenticateResponse> {
    return {}
  }

  async initialize(
    params: acp.InitializeRequest,
  ): Promise<acp.InitializeResponse> {
    logRequest('initialize', params)
    const result: acp.InitializeResponse = {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        ...(flag('OMIT_LOAD_SESSION_CAPABILITY') ? {} : { loadSession: true }),
        ...(flag('ADVERTISE_SESSION_FORK')
          ? ({ session: { fork: {} } } as unknown as acp.AgentCapabilities)
          : {}),
        promptCapabilities: { image: false },
      },
    }
    if (flag('EXIT_AFTER_INITIALIZE')) setTimeout(() => process.exit(0), 0)
    return result
  }

  async newSession(
    params: acp.NewSessionRequest,
  ): Promise<acp.NewSessionResponse> {
    logRequest('session/new', params)
    if (flag('EMIT_UNSOLICITED_UPDATES_AFTER_NEW')) {
      setTimeout(
        () =>
          void this.connection.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'unsolicited' },
            },
          }),
        numberFlag('UNSOLICITED_UPDATES_AFTER_NEW_DELAY_MS', 300),
      )
    }
    return { sessionId }
  }

  async loadSession(
    params: acp.LoadSessionRequest,
  ): Promise<acp.LoadSessionResponse> {
    logRequest('session/load', params)
    if (flag('FAIL_LOAD_SESSION')) throw new Error('mock load failed')
    if (flag('EMIT_LOAD_REPLAY')) {
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'replayed' },
        },
      })
    }
    return {}
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    logRequest('session/prompt', params)
    if (
      flag('REJECT_OVERLAPPING_PROMPTS') &&
      this.active.has(params.sessionId)
    ) {
      throw new Error('overlapping prompt rejected')
    }
    const controller = new AbortController()
    this.active.set(params.sessionId, controller)
    try {
      if (flag('HANG_PROMPT'))
        await new Promise<void>((_, reject) =>
          controller.signal.addEventListener(
            'abort',
            () => reject(new Error('cancelled')),
            { once: true },
          ),
        )
      else await this.turn(params, controller.signal)
      return { stopReason: 'end_turn' }
    } catch {
      return { stopReason: 'cancelled' }
    } finally {
      this.active.delete(params.sessionId)
    }
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    logRequest('session/cancel', params)
    this.active.get(params.sessionId)?.abort()
    if (numberFlag('CANCEL_DELAY_MS') > 0)
      await delay(numberFlag('CANCEL_DELAY_MS'))
    if (flag('EMIT_LATE_UPDATE_AFTER_CANCEL')) {
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'late update' },
        },
      })
    }
  }

  private async turn(
    params: acp.PromptRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const input = params.prompt
      .filter((part) => part.type === 'text')
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join(' ')
    if (flag('EMIT_THOUGHT'))
      await this.update(params.sessionId, {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking' },
      })
    if (flag('EMIT_TOOL_CALLS') || flag('EMIT_SUBAGENT')) {
      const toolCallId = flag('EMIT_SUBAGENT') ? 'subagent-1' : 'tool-1'
      await this.update(params.sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: flag('EMIT_SUBAGENT') ? 'Research' : 'Read files',
        kind: 'read',
        status: 'in_progress',
        rawInput: flag('EMIT_SUBAGENT')
          ? { subagent_type: 'researcher' }
          : { path: '/tmp/example' },
      })
      await this.update(params.sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'in_progress',
      })
      await this.update(params.sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: flag('EMIT_SUBAGENT')
                ? 'agent_id: researcher-1\nactual_subagent_type: researcher\nstatus: completed'
                : 'file contents',
            },
          },
        ],
      })
    }
    if (flag('REQUEST_PERMISSION') || flag('ASK_QUESTION')) {
      const question = flag('ASK_QUESTION')
      const outcome = await this.connection.requestPermission({
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: 'permission-1',
          title: question ? 'AskUserQuestion' : 'Run command',
          kind: 'other',
          status: 'pending',
          rawInput: question
            ? {
                questions: [
                  {
                    header: 'Choice',
                    question: 'Pick one',
                    options: [
                      { label: 'First', value: 'first' },
                      { label: 'Second', value: 'second' },
                    ],
                  },
                ],
              }
            : { command: 'echo mock' },
        },
        options: [
          { kind: 'allow_once', name: 'Allow once', optionId: 'allow-once' },
          {
            kind: 'allow_always',
            name: 'Allow always',
            optionId: 'allow-always',
          },
          { kind: 'reject_once', name: 'Reject once', optionId: 'reject-once' },
        ],
      })
      const selected =
        outcome.outcome.outcome === 'selected'
          ? outcome.outcome.optionId
          : outcome.outcome.outcome
      if (requestLogPath)
        appendFileSync(
          requestLogPath,
          `${JSON.stringify({ permissionOutcome: selected })}\n`,
        )
      await this.update(params.sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `selected: ${selected}` },
      })
    }
    await delay(numberFlag('PROMPT_DELAY_MS'), signal)
    if (flag('EXIT_MID_TURN')) process.exit(0)
    const text = env.FORGE_MOCK_PROMPT_RESPONSE_TEXT ?? input
    const chunks = text.length
      ? [
          text.slice(0, Math.ceil(text.length / 3)),
          text.slice(
            Math.ceil(text.length / 3),
            Math.ceil((text.length * 2) / 3),
          ),
          text.slice(Math.ceil((text.length * 2) / 3)),
        ]
      : ['']
    for (const chunk of chunks) {
      await this.update(params.sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: chunk },
      })
    }
  }

  private update(
    sessionId: string,
    update: acp.SessionNotification['update'],
  ): Promise<void> {
    return this.connection.sessionUpdate({ sessionId, update })
  }
}

const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>
new acp.AgentSideConnection(
  (connection) => new MockAgent(connection),
  acp.ndJsonStream(output, input),
)
