import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { launchForge, type ForgeServer } from '../helpers/forgeServer.js'

async function post<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok)
    throw new Error(
      `${url} failed: ${response.status} ${await response.text()}`,
    )
  return (await response.json()) as T
}

// The real server needs a named project on a real path, and a session bound to
// a harness and a working directory. The data directory is already a repo.
async function createSession(forge: ForgeServer): Promise<string> {
  const project = await post<{ id: string }>(`${forge.baseUrl}/api/projects`, {
    name: 'Smoke project',
    path: forge.dataDir,
  })
  const session = await post<{ id: string }>(`${forge.baseUrl}/api/sessions`, {
    projectId: project.id,
    harness: 'mock',
    cwd: forge.dataDir,
  })
  return session.id
}

test('creates a project and session, then replays streamed messages', async () => {
  const forge = await launchForge()
  try {
    const sessionId = await createSession(forge)
    const socket = new WebSocket(`${forge.baseUrl.replace('http', 'ws')}/ws`)
    const messages: Array<{ seq: number; type: string; role: string }> = []
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data as string)
      if (data.msg) messages.push(data.msg)
    }
    await new Promise<void>((resolve) => {
      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            type: 'subscribe',
            sessions: [sessionId],
            cursor: 0,
          }),
        )
        resolve()
      }
    })
    await post(`${forge.baseUrl}/api/sessions/${sessionId}/prompt`, {
      text: 'hello',
    })
    await expect
      .poll(() => messages.some((message) => message.type === 'turn_end'))
      .toBe(true)
    expect(messages.map((message) => message.seq)).toEqual(
      [...messages].map((message) => message.seq).sort((a, b) => a - b),
    )
    // The prompt itself is persisted as a user text_delta, so count the agent's
    // chunks alone. The fixture always splits its reply into three.
    expect(
      messages.filter(
        (message) => message.type === 'text_delta' && message.role === 'agent',
      ),
    ).toHaveLength(3)
    socket.close()
  } finally {
    await forge.stop()
  }
})

test('reconnects after restart without losing the cursor', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/forge-restart-`)
  const first = await launchForge({
    dataDir,
    env: { FORGE_MOCK_HANG_PROMPT: '1' },
  })
  const sessionId = await createSession(first)
  await post(`${first.baseUrl}/api/sessions/${sessionId}/prompt`, {
    text: 'hang',
  })
  await first.stop()

  const second = await launchForge({ dataDir })
  try {
    const socket = new WebSocket(`${second.baseUrl.replace('http', 'ws')}/ws`)
    const messages: Array<{ seq: number; type: string; role: string }> = []
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data as string)
      if (data.msg) messages.push(data.msg)
    }
    await new Promise<void>((resolve) => {
      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            type: 'subscribe',
            sessions: [sessionId],
            cursor: 1,
          }),
        )
        resolve()
      }
    })
    await expect
      .poll(() =>
        messages.some((message) => message.type === 'turn_interrupted'),
      )
      .toBe(true)
    expect(messages.map((message) => message.seq)).toEqual(
      [...messages].map((message) => message.seq).sort((a, b) => a - b),
    )
    socket.close()
  } finally {
    await second.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
})
