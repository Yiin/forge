import { expect, test } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { launchForge, type ForgeServer } from '../helpers/forgeServer.js'

test.describe.configure({ retries: 0 })

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
  let originalSocket: WebSocket | undefined
  try {
    const sessionId = await createSession(forge)
    const socket = new WebSocket(`${forge.baseUrl.replace('http', 'ws')}/ws`)
    originalSocket = socket
    const messages: Array<{
      seq: number
      type: string
      role: string
      itemId: string
      turnId: string
      content: { text?: string }
    }> = []
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
    const reply = messages.filter(
      (message) => message.type === 'text_delta' && message.role === 'agent',
    )
    expect(reply.map((message) => message.content.text)).toEqual([
      'he',
      'll',
      'o',
    ])
    for (const message of reply) {
      expect(message.itemId).toEqual(expect.any(String))
      expect(message.itemId.length).toBeGreaterThan(0)
      expect(message.turnId).toEqual(expect.any(String))
      expect(message.turnId.length).toBeGreaterThan(0)
    }
    expect(new Set(reply.map((message) => message.itemId)).size).toBe(1)
    expect(new Set(reply.map((message) => message.turnId)).size).toBe(1)
    expect(new Set(messages.map((message) => message.seq)).size).toBe(
      messages.length,
    )
    expect(reply.map((message) => message.content.text).join('')).toBe('hello')
  } finally {
    try {
      originalSocket?.close()
    } finally {
      await forge.stop()
    }
  }
})

for (const phase of ['accepted', 'admitted'] as const)
  test(`reconnects after ${phase} prompt restart without losing the cursor`, async () => {
    const dataDir = await mkdtemp(`${tmpdir()}/forge-restart-`)
    const first = await launchForge({
      dataDir,
      fakeAgentEnv: {
        FORGE_MOCK_HANG_PROMPT: '1',
        FORGE_MOCK_REQUEST_LOG_PATH: `${dataDir}/agent.jsonl`,
      },
    })
    let sessionId: string
    try {
      sessionId = await createSession(first)
      await post(`${first.baseUrl}/api/sessions/${sessionId}/prompt`, {
        text: 'hang',
      })
      if (phase === 'admitted')
        await expect
          .poll(async () =>
            (await readFile(`${dataDir}/agent.jsonl`, 'utf8').catch(() => ''))
              .split('\n')
              .filter(Boolean)
              .some((line) => JSON.parse(line).method === 'session/prompt'),
          )
          .toBe(true)
    } finally {
      await first.stop()
    }

    const second = await launchForge({ dataDir })
    let originalSocket: WebSocket | undefined
    try {
      const socket = new WebSocket(`${second.baseUrl.replace('http', 'ws')}/ws`)
      originalSocket = socket
      const messages: Array<{
        seq: number
        type: string
        role: string
        content: { text?: string }
      }> = []
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
      // Restart recovery runs before the server accepts requests. Under full
      // gate load, the first replay can still arrive after Playwright's
      // five-second polling default. Keep the assertion bounded, but separate
      // the recovery budget from the test runner's retry mechanism.
      await expect
        .poll(
          () => messages.some((message) => message.type === 'turn_interrupted'),
          { timeout: 15_000, intervals: [100, 250, 500, 1_000] },
        )
        .toBe(true)
      expect(messages.map((message) => message.seq)).toEqual(
        [...messages].map((message) => message.seq).sort((a, b) => a - b),
      )
      expect(
        messages.filter((message) => message.type === 'turn_interrupted'),
      ).toHaveLength(1)
      expect(
        messages.filter(
          (message) => message.type === 'error' || message.type === 'turn_end',
        ),
      ).toEqual([])
      expect(
        messages.some(
          (message) =>
            message.role === 'user' && message.content.text === 'hang',
        ),
      ).toBe(true)
    } finally {
      try {
        originalSocket?.close()
      } finally {
        await second.stop()
      }
      await rm(dataDir, { recursive: true, force: true })
    }
  })
