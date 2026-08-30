import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  spawnAcpClient,
  AgentProcessDiedError,
  CapabilityUnsupportedError,
} from '../src/acp/client.js'
import { spawnMockAgent } from './helpers/mock-agent.js'

const clients: Array<{ kill(): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.kill()))
})

const entry = (flags: Record<string, string> = {}) => {
  const command = spawnMockAgent(flags)
  return {
    name: 'mock',
    command: command.command,
    args: command.args,
    env: command.env as Record<string, string>,
    protocol: 'acp' as const,
    enabled: true,
  }
}

describe('ACP client', () => {
  it('initializes, streams unsolicited updates, and prompts', async () => {
    const updates: string[] = []
    const client = await spawnAcpClient(
      entry({ EMIT_UNSOLICITED_UPDATES_AFTER_NEW: '1' }),
      {
        onSessionUpdate: ({ update }) => {
          if (
            update.sessionUpdate === 'agent_message_chunk' &&
            update.content.type === 'text'
          )
            updates.push(update.content.text)
        },
      },
    )
    clients.push(client)
    const session = await client.newSession('/tmp')
    const response = await client.prompt(session.sessionId, [
      { type: 'text', text: 'hello' },
    ])
    expect(response.stopReason).toBe('end_turn')
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(updates.join('')).toContain('hello')
    expect(updates.join('')).toContain('unsolicited')
  })

  it('spawns despite an advertised auth method the agent cannot run', async () => {
    // Regression: claude-code-acp advertises authMethods but answers
    // authenticate with a JSON-RPC error. The SDK rejects with the raw plain
    // object; a proactive authenticate must not kill the spawn.
    const client = await spawnAcpClient(entry({ FAIL_AUTHENTICATE: '1' }))
    clients.push(client)
    const session = await client.newSession('/tmp')
    expect(session.sessionId).toBe('forge-mock-session')
    const response = await client.prompt(session.sessionId, [
      { type: 'text', text: 'hello' },
    ])
    expect(response.stopReason).toBe('end_turn')
  })

  it('forwards the working directory to the child process', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-acp-cwd-'))
    const requestLogPath = join(cwd, 'requests.jsonl')
    const client = await spawnAcpClient(
      entry({ REQUEST_LOG_PATH: requestLogPath }),
      { cwd },
    )
    clients.push(client)
    await client.newSession(cwd)

    const lines = (await readFile(requestLogPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { params?: { processCwd?: string } })
    expect(
      lines.find((line) => line.params?.processCwd)?.params?.processCwd,
    ).toBe(cwd)
  })

  it('sends session/set_model when selecting an advertised model', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-acp-model-'))
    const requestLogPath = join(cwd, 'requests.jsonl')
    const client = await spawnAcpClient(
      entry({ REQUEST_LOG_PATH: requestLogPath }),
      { cwd },
    )
    clients.push(client)
    const session = await client.newSession(cwd)

    expect(client.capabilities.setModel).toBe(true)
    await client.setModel(session.sessionId, 'mock-smart')

    const requests = (await readFile(requestLogPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method: string; params: unknown })
    expect(requests).toContainEqual({
      method: 'session/set_model',
      params: { sessionId: session.sessionId, modelId: 'mock-smart' },
    })
  })

  it('rejects unadvertised load sessions and overlapping prompts', async () => {
    const client = await spawnAcpClient(
      entry({ OMIT_LOAD_SESSION_CAPABILITY: '1', HANG_PROMPT: '1' }),
    )
    clients.push(client)
    expect(client.capabilities.loadSession).toBe(false)
    await expect(client.loadSession('missing', '/tmp')).rejects.toBeInstanceOf(
      CapabilityUnsupportedError,
    )
    const session = await client.newSession('/tmp')
    const first = client.prompt(session.sessionId, [
      { type: 'text', text: 'one' },
    ])
    await expect(
      client.prompt(session.sessionId, [{ type: 'text', text: 'two' }]),
    ).rejects.toThrow('already active')
    await client.cancel(session.sessionId)
    await first
  })

  it('detects the unstable session/fork capability', async () => {
    const client = await spawnAcpClient(entry({ ADVERTISE_SESSION_FORK: '1' }))
    clients.push(client)
    expect(client.capabilities.sessionFork).toBe(true)
  })

  it('reports process death with the stderr ring', async () => {
    const exits: AgentProcessDiedError[] = []
    const client = await spawnAcpClient(entry({ EXIT_MID_TURN: '1' }), {
      onExit: (error) => {
        exits.push(error)
      },
    })
    clients.push(client)
    const session = await client.newSession('/tmp')
    await expect(
      client.prompt(session.sessionId, [{ type: 'text', text: 'die' }]),
    ).rejects.toBeInstanceOf(AgentProcessDiedError)
    expect(exits).toHaveLength(1)
  })
})
