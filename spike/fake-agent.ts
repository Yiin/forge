import { Readable, Writable } from "node:stream";
import * as acp from "@zed-industries/agent-client-protocol";

class FakeAgent implements acp.Agent {
  constructor(private readonly connection: acp.AgentSideConnection) {}

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } };
  }

  async newSession(_params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    return { sessionId: "spike-session" };
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "acp-ok" } },
    });
    return { stopReason: "end_turn" };
  }

  async cancel(_params: acp.CancelNotification): Promise<void> {}
}

const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
new acp.AgentSideConnection((connection) => new FakeAgent(connection), acp.ndJsonStream(output, input));
