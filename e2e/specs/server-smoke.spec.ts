import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { launchForge } from '../helpers/forgeServer.js'

test('creates a project and session, then replays streamed messages', async () => {
  const forge = await launchForge()
  try {
    const project = (await (
      await fetch(`${forge.baseUrl}/api/projects`, {
        method: 'POST',
        body: '{}',
      })
    ).json()) as { id: string }
    const session = (await (
      await fetch(`${forge.baseUrl}/api/projects/${project.id}/sessions`, {
        method: 'POST',
        body: '{}',
      })
    ).json()) as { id: string }
    const socket = new WebSocket(`${forge.baseUrl.replace('http', 'ws')}/ws`)
    const messages: Array<{ seq: number; type: string }> = []
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data as string)
      if (data.message) messages.push(data.message)
    }
    await new Promise<void>((resolve) => {
      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            type: 'subscribe',
            sessions: [session.id],
            cursor: 0,
          }),
        )
        resolve()
      }
    })
    await fetch(`${forge.baseUrl}/api/sessions/${session.id}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ prompt: 'hello' }),
    })
    await expect
      .poll(() => messages.some((message) => message.type === 'turn_end'))
      .toBe(true)
    expect(messages.map((message) => message.seq)).toEqual(
      [...messages].map((message) => message.seq).sort((a, b) => a - b),
    )
    expect(
      messages.filter((message) => message.type === 'text_delta'),
    ).toHaveLength(3)
    socket.close()
  } finally {
    await forge.stop()
  }
})

test('reconnects after restart without losing the cursor', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/forge-restart-`)
  const first = await launchForge({ dataDir, env: { FORGE_FAKE_HANG: '1' } })
  const project = (await (
    await fetch(`${first.baseUrl}/api/projects`, { method: 'POST', body: '{}' })
  ).json()) as { id: string }
  const session = (await (
    await fetch(`${first.baseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      body: '{}',
    })
  ).json()) as { id: string }
  await fetch(`${first.baseUrl}/api/sessions/${session.id}/prompt`, {
    method: 'POST',
    body: '{}',
  })
  await first.stop()

  const second = await launchForge({ dataDir })
  try {
    const socket = new WebSocket(`${second.baseUrl.replace('http', 'ws')}/ws`)
    const messages: Array<{ seq: number; type: string }> = []
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data as string)
      if (data.message) messages.push(data.message)
    }
    await new Promise<void>((resolve) => {
      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            type: 'subscribe',
            sessions: [session.id],
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
