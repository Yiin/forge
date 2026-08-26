import { expect, test, type Page } from '@playwright/test'
import { launchForge } from '../helpers/forgeServer.js'

async function openQuestion(page: Page, mode = 'single') {
  const forge = await launchForge({
    env: {
      FORGE_MOCK_ASK_QUESTION: '1',
      FORGE_MOCK_ASK_QUESTION_MODE: mode,
    },
  })
  await page.route('**/api/**', async (route) => {
    const target = `${forge.baseUrl}${new URL(route.request().url()).pathname}`
    const response = await fetch(target, {
      method: route.request().method(),
      headers: {
        'content-type':
          route.request().headers()['content-type'] ?? 'application/json',
      },
      body: route.request().postDataBuffer() ?? undefined,
    })
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    })
  })
  await page.addInitScript((url) => {
    const NativeWebSocket = window.WebSocket
    const socketUrl = url.replace(/^http/, 'ws') + '/ws'
    const ForgeWebSocket = function (
      this: WebSocket,
      _url: string,
      protocols?: string | string[],
    ) {
      return new NativeWebSocket(socketUrl, protocols)
    } as unknown as typeof WebSocket
    ForgeWebSocket.prototype = NativeWebSocket.prototype
    window.WebSocket = ForgeWebSocket
  }, forge.baseUrl)
  await page.goto('/')
  const shell = page.locator(
    test.info().project.name === 'phone' ? '.phone-shell' : '.desktop-shell',
  )
  await shell.getByLabel('Project name').fill('Question project')
  await shell.getByRole('button', { name: 'Add project' }).click()
  await page.waitForURL(/\/s\//)
  await shell.getByLabel('Message composer').fill('ask me')
  await shell.getByRole('button', { name: 'Send' }).click()
  await expect(
    shell.getByRole('region', { name: 'Question from Forge' }),
  ).toBeVisible()
  return { forge, shell }
}

test('answers a single question and keeps the answer after reload', async ({
  page,
}) => {
  const { forge, shell } = await openQuestion(page)
  try {
    await page.reload()
    await expect(
      shell.getByRole('region', { name: 'Question from Forge' }),
    ).toBeVisible()
    await shell.getByRole('button', { name: 'First' }).click()
    await expect(shell.getByText('First')).toBeVisible()
    await page.reload()
    await expect(
      shell.getByRole('region', { name: 'Question from Forge' }),
    ).toHaveCount(0)
    await expect(shell.getByText('First')).toBeVisible()
  } finally {
    await forge.stop()
  }
})

test('answers queued questions in order', async ({ page }) => {
  const { forge, shell } = await openQuestion(page, 'queued')
  try {
    const panel = shell.getByRole('region', { name: 'Question from Forge' })
    await expect(panel.getByText('2 questions')).toBeVisible()
    await panel.getByRole('button', { name: 'First' }).click()
    await expect(
      panel.getByRole('heading', { name: 'Pick another one' }),
    ).toBeVisible()
    await panel.getByRole('button', { name: 'Third' }).click()
    await expect(panel).toHaveCount(0)
  } finally {
    await forge.stop()
  }
})

test('answers a multi-select question on the phone viewport', async ({
  page,
}) => {
  const { forge, shell } = await openQuestion(page, 'multi')
  try {
    const panel = shell.getByRole('region', { name: 'Question from Forge' })
    await panel.getByRole('button', { name: 'Cheese' }).click()
    await panel.getByRole('button', { name: 'Mushrooms' }).click()
    await panel.getByRole('button', { name: 'Confirm selection' }).click()
    await expect(panel).toHaveCount(0)
  } finally {
    await forge.stop()
  }
})
