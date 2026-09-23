import { expect, test, type Page } from '@playwright/test'
import {
  launchForge,
  proxyForgeApi,
  stopProxiedForge,
  type ForgeServer,
} from '../helpers/forgeServer.js'

const PROMPT = '**/api/sessions/*/prompt'

/**
 * Points the app's socket at the isolated server and lets a test hold it
 * down: `__forgeSocketDown` refuses new sockets and closes the open ones.
 */
async function connectSocket(page: Page, forge: ForgeServer) {
  await page.addInitScript((url) => {
    const NativeWebSocket = window.WebSocket
    const socketUrl = url.replace(/^http/, 'ws') + '/ws'
    const open: WebSocket[] = []
    const state = window as unknown as {
      __forgeSocketDown?: (down: boolean) => void
    }
    let down = false
    state.__forgeSocketDown = (next) => {
      down = next
      if (down) for (const socket of open.splice(0)) socket.close()
    }
    const ForgeWebSocket = function (
      this: WebSocket,
      url: string,
      protocols?: string | string[],
    ) {
      // Vite's own socket reloads the page when it drops, so leave it be.
      if (String(protocols).startsWith('vite-'))
        return new NativeWebSocket(url, protocols)
      // Port 9 refuses the connection, so the app keeps reconnecting.
      const socket = new NativeWebSocket(
        down ? 'ws://127.0.0.1:9/ws' : socketUrl,
        protocols,
      )
      if (!down) open.push(socket)
      return socket
    } as unknown as typeof WebSocket
    ForgeWebSocket.prototype = NativeWebSocket.prototype
    window.WebSocket = ForgeWebSocket
  }, forge.baseUrl)
}

const setSocketDown = (page: Page, down: boolean) =>
  page.evaluate(
    (value) =>
      (
        window as unknown as { __forgeSocketDown: (down: boolean) => void }
      ).__forgeSocketDown(value),
    down,
  )

async function openSession(page: Page, forge: ForgeServer) {
  const post = async (path: string, body: unknown) => {
    const response = await fetch(forge.baseUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(response.ok).toBe(true)
    return response.json()
  }
  const project = await post('/api/projects', {
    name: 'Delivery',
    path: forge.dataDir,
  })
  const session = await post('/api/sessions', {
    projectId: project.id,
    harness: 'mock',
    cwd: forge.dataDir,
    title: 'Delivery',
  })
  await page.goto(`/s/${session.id}`)
  await expect(page.locator('.chat-lifecycle-status')).toHaveCount(0)
  return session.id as string
}

async function userTexts(forge: ForgeServer, sessionId: string) {
  const response = await fetch(
    `${forge.baseUrl}/api/sessions/${sessionId}/messages`,
  )
  const body = await response.json()
  return ((body.messages ?? body) as any[])
    .filter(
      (message) =>
        message.role === 'user' && message.content.type === 'text_delta',
    )
    .map((message) => message.content.text as string)
}

test.describe.configure({ retries: 0 })

test('keeps a send that got no answer and retries it once', async ({
  page,
}) => {
  const forge = await launchForge()
  try {
    await proxyForgeApi(page, forge)
    await connectSocket(page, forge)
    const sessionId = await openSession(page, forge)
    await page.route(PROMPT, (route) => route.abort('connectionfailed'))
    const composer = page.getByRole('textbox', { name: 'Message composer' })
    await composer.fill('Deliver this once')
    await page.getByRole('button', { name: 'Send', exact: true }).click()

    // The prompt keeps its place; the composer does not take it back.
    const bubble = page.locator('.chat-user[data-pending="true"]')
    await expect(bubble).toContainText('Deliver this once')
    await expect(bubble).toHaveAttribute('data-delivery', 'unsent')
    await expect(composer).toHaveValue('')
    await expect(page.getByRole('alert')).toHaveCount(0)
    const retry = page
      .locator('.chat-working')
      .getByRole('button', { name: 'Not delivered, click to retry' })
    await expect(retry).toBeVisible()
    // The working line stays the last row.
    await expect(page.locator('.chat-timeline .chat-working')).toHaveCount(1)

    await page.unroute(PROMPT)
    await retry.click()
    await expect(bubble).toHaveCount(0)
    await expect(page.locator('.chat-user')).toContainText('Deliver this once')
    await expect(page.locator('.chat-working')).toHaveCount(0, {
      timeout: 15_000,
    })
    expect(await userTexts(forge, sessionId)).toEqual(['Deliver this once'])
  } finally {
    await stopProxiedForge(page, forge)
  }
})

test('shows a landed send once when its answer was lost', async ({ page }) => {
  const forge = await launchForge()
  try {
    await proxyForgeApi(page, forge)
    await connectSocket(page, forge)
    const sessionId = await openSession(page, forge)
    // The server takes the prompt, then the answer never comes back. The
    // client's own retry reuses the key, so the server drops the copy.
    await page.route(PROMPT, async (route) => {
      const request = route.request()
      const headers = { ...request.headers() }
      for (const key of ['host', 'accept-encoding', 'connection', 'referer'])
        delete headers[key]
      await fetch(forge.baseUrl + new URL(request.url()).pathname, {
        method: 'POST',
        headers,
        body: request.postDataBuffer() ?? undefined,
      })
      await route.abort('connectionfailed')
    })
    await page
      .getByRole('textbox', { name: 'Message composer' })
      .fill('Landed already')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.locator('.chat-user')).toContainText('Landed already')
    await expect(page.locator('.chat-working')).toHaveCount(0, {
      timeout: 15_000,
    })
    await expect(
      page.getByRole('button', { name: 'Not delivered, click to retry' }),
    ).toHaveCount(0)
    await expect(page.locator('.chat-user')).toHaveCount(1)
    expect(await userTexts(forge, sessionId)).toEqual(['Landed already'])
  } finally {
    await stopProxiedForge(page, forge)
  }
})

test('queues a send while the connection is down and delivers it on return', async ({
  page,
}) => {
  const forge = await launchForge()
  try {
    await proxyForgeApi(page, forge)
    await connectSocket(page, forge)
    const sessionId = await openSession(page, forge)
    await setSocketDown(page, true)
    await page.route(PROMPT, (route) => route.abort('internetdisconnected'))
    await expect(
      page.getByRole('status').filter({
        hasText: 'Messages will send once the connection recovers.',
      }),
    ).toBeVisible()

    const composer = page.getByRole('textbox', { name: 'Message composer' })
    await composer.fill('Send when back')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const bubble = page.locator('.chat-user[data-pending="true"]')
    await expect(bubble).toContainText('Send when back')
    await expect(composer).toHaveValue('')
    const working = page.locator('.chat-working')
    await expect(working).toContainText('Queued, will send automatically')
    await expect(working.getByRole('button')).toHaveCount(0)
    expect(await userTexts(forge, sessionId)).toEqual([])

    await page.unroute(PROMPT)
    await setSocketDown(page, false)
    // The socket backs off up to 10 seconds between attempts.
    await expect(bubble).toHaveCount(0, { timeout: 20_000 })
    await expect(page.locator('.chat-user')).toContainText('Send when back')
    await expect(
      page.getByText('Messages will send once the connection recovers.'),
    ).toHaveCount(0)
    await expect(working).toHaveCount(0, { timeout: 15_000 })
    expect(await userTexts(forge, sessionId)).toEqual(['Send when back'])
  } finally {
    await stopProxiedForge(page, forge)
  }
})
