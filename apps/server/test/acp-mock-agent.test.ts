import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import * as acp from '@zed-industries/agent-client-protocol'
import { spawnMockAgent } from './helpers/mock-agent.js'

const children: ReturnType<typeof spawn>[] = []
afterEach(() => {
  for (const child of children.splice(0)) child.kill()
})

describe('ACP mock agent', () => {
  it('completes the default echo round trip and logs requests', async () => {
    const dir = await mkdtemp(`${tmpdir()}/forge-mock-`)
    const log = `${dir}/requests.jsonl`
    const command = spawnMockAgent({ REQUEST_LOG_PATH: log })
    const child = spawn(command.command, command.args, {
      env: command.env,
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    children.push(child)
    const updates: string[] = []
    const client: acp.Client = {
      requestPermission: async () => ({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      }),
      sessionUpdate: async ({ update }) => {
        if (
          update.sessionUpdate === 'agent_message_chunk' &&
          update.content.type === 'text'
        )
          updates.push(update.content.text)
      },
    }
    const connection = new acp.ClientSideConnection(
      () => client,
      acp.ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
      ),
    )
    const initialized = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    })
    expect(initialized.agentCapabilities?.loadSession).toBe(true)
    const session = await connection.newSession({ cwd: dir, mcpServers: [] })
    expect(
      (
        await connection.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'hello' }],
        })
      ).stopReason,
    ).toBe('end_turn')
    expect(updates.join('')).toBe('hello')
    expect(
      (await readFile(log, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line).method),
    ).toEqual(['initialize', 'session/new', 'session/prompt'])
    await rm(dir, { recursive: true, force: true })
  })
})
