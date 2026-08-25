import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@zed-industries/agent-client-protocol";
import * as pty from "node-pty";

const root = dirname(fileURLToPath(import.meta.url));
// Bun embeds text imports in compiled binaries. Node's fallback build replaces
// this import with a build-time asset copy beside the generated server.
// @ts-expect-error Bun's text import attribute is not part of TypeScript's module types.
import embeddedIndex from "./index.html" with { type: "text" };

function checkEmbeddedAsset(): void {
  if (!embeddedIndex.includes("embedded-ok")) throw new Error("embedded asset check failed");
}

async function checkPty(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const shell = pty.spawn("bash", ["-lc", "echo pty-ok"], { cols: 80, rows: 24 });
    let output = "";
    const timeout = setTimeout(() => {
      shell.kill();
      reject(new Error("pty check timed out"));
    }, 2000);
    shell.onData((data) => {
      output += data;
      if (output.includes("pty-ok")) {
        clearTimeout(timeout);
        shell.kill();
        resolve();
      }
    });
    shell.onExit(({ exitCode }) => {
      if (exitCode !== 0 && !output.includes("pty-ok")) {
        clearTimeout(timeout);
        reject(new Error(`pty exited ${exitCode}`));
      }
    });
  });
}

async function checkAcp(): Promise<void> {
  const agent = spawn(process.execPath, [join(root, "fake-agent.ts")], { stdio: ["pipe", "pipe", "inherit"] });
  const input = Writable.toWeb(agent.stdin!) as WritableStream<Uint8Array>;
  const output = Readable.toWeb(agent.stdout!) as ReadableStream<Uint8Array>;
  const updates: string[] = [];
  const client: acp.Client = { sessionUpdate: async ({ update }) => {
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") updates.push(update.content.text);
  } };
  const connection = new acp.ClientSideConnection(() => client, acp.ndJsonStream(input, output));
  try {
    const initialized = await connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error("ACP version mismatch");
    const session = await connection.newSession({ cwd: root, mcpServers: [] });
    const result = await connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "ping" }] });
    if (result.stopReason !== "end_turn" || !updates.includes("acp-ok")) throw new Error("ACP round-trip check failed");
  } finally {
    agent.kill();
  }
}

checkEmbeddedAsset();
await checkPty();
await checkAcp();
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(embeddedIndex);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const address = server.address();
console.log(`runtime-spike-ok port=${typeof address === "object" && address ? address.port : "unknown"}`);
server.close();
