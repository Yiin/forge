import { Readable, Writable } from 'node:stream'
import * as acp from '@zed-industries/agent-client-protocol'

class FakeAgent implements acp.Agent {
  constructor(private readonly connection: acp.AgentSideConnection) {}
  async initialize(): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities:
        process.env.FORGE_FAKE_NO_LOAD_SESSION === '1'
          ? {}
          : { loadSession: true },
    }
  }
  async newSession(): Promise<acp.NewSessionResponse> {
    return { sessionId: 'fake-session' }
  }
  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    if (process.env.FORGE_FAKE_HANG === '1') await new Promise<void>(() => {})
    for (const text of ['first ', 'second ', 'third'])
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
        },
      })
    return { stopReason: 'end_turn' }
  }
  async cancel(): Promise<void> {}
}

const connection = new acp.AgentSideConnection(
  (conn) => new FakeAgent(conn),
  acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
)
void connection
