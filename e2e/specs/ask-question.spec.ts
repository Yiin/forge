import { expect, test, type Page } from '@playwright/test'
import {
  launchForge,
  proxyForgeApi,
  stopProxiedForge,
} from '../helpers/forgeServer.js'

async function openQuestion(page: Page, mode = 'single') {
  const forge = await launchForge({
    env: {
      FORGE_MOCK_ASK_QUESTION: '1',
      FORGE_MOCK_ASK_QUESTION_MODE: mode,
    },
  })
  try {
    await proxyForgeApi(page, forge)
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
    // The shadcn rebuild collapsed the desktop/phone shell classes into one
    // `.phone-shell` hook on the app root; both viewports use it now.
    const shell = page.locator('.phone-shell')
    await shell.getByRole('button', { name: 'Add project' }).click()
    const projectDialog = page.getByRole('dialog', { name: 'Create project' })
    await projectDialog.getByLabel('Name').fill('Question project')
    await projectDialog.getByLabel('Folder path').fill(forge.dataDir)
    await projectDialog.getByRole('button', { name: 'Create project' }).click()
    await page.waitForURL(/\/draft\//)
    await shell.getByLabel('Message composer').fill('ask me')
    await shell.getByRole('button', { name: 'Send' }).click()
    await page.waitForURL(/\/s\//)
    // Promotion sends the draft's text as the session's first prompt, and the
    // fixture asks its question on that prompt. A second send would only be
    // queued behind the turn already waiting for an answer.
    await expect(
      shell.getByRole('region', { name: 'Question from Forge' }),
    ).toBeVisible()
    return { forge, shell }
  } catch (setupError) {
    await stopProxiedForge(page, forge).catch(() => undefined)
    throw setupError
  }
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
    const answeredRow = shell.locator('.chat-answered-question')
    await expect(answeredRow.getByText('First')).toBeVisible()
    await page.reload()
    await expect(
      shell.getByRole('region', { name: 'Question from Forge' }),
    ).toHaveCount(0)
    await expect(
      shell.locator('.chat-answered-question').getByText('First'),
    ).toBeVisible()
  } finally {
    await stopProxiedForge(page, forge)
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
    await stopProxiedForge(page, forge)
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
    await stopProxiedForge(page, forge)
  }
})
