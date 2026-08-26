import { expect, test } from '@playwright/test'
import { launchForge, stopProxiedForge } from '../helpers/forgeServer.js'

test('creates a project, sends a prompt, and replays the full streamed reply', async ({
  page,
  baseURL,
}) => {
  const forge = await launchForge({
    fakeAgentEnv: { FORGE_MOCK_PROMPT_DELAY_MS: '120' },
  })
  try {
    if (test.info().project.name.startsWith('phone'))
      await page.setViewportSize({ width: 390, height: 844 })
    await page.route('**/api/**', async (route) => {
      const target = `${forge.baseUrl}${new URL(route.request().url()).pathname}${new URL(route.request().url()).search}`
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
      // Keep the browser API shape while pointing the app at the isolated server.
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
    await page.goto(baseURL ?? '/')
    const shell = test.info().project.name.startsWith('phone')
      ? '.phone-shell'
      : '.desktop-shell'
    await page
      .locator(shell)
      .getByRole('button', { name: 'Add project' })
      .click()
    const projectDialog = page.getByRole('dialog', { name: 'Create project' })
    await projectDialog.getByLabel('Name').fill('Browser project')
    await projectDialog.getByLabel('Folder path').fill(forge.dataDir)
    await projectDialog.getByRole('button', { name: 'Create project' }).click()
    await page.waitForURL(/\/draft\//, { timeout: 10_000 })
    const composer = page.locator(shell).getByLabel('Message composer')
    await expect(composer).toBeVisible()
    await composer.fill('hello from the browser')
    await page.locator(shell).getByRole('button', { name: 'Send' }).click()
    await page.waitForURL(/\/s\//, { timeout: 10_000 })
    await page.waitForTimeout(160)
    await page.reload()
    await expect(
      page.locator(shell).getByText('first second third'),
    ).toBeVisible({
      timeout: 10_000,
    })
    if (test.info().project.name.startsWith('phone')) {
      await expect(composer).toBeVisible()
      await expect(composer).toBeEnabled()
      const box = await composer.boundingBox()
      expect(box?.y).toBeGreaterThan(0)
      expect(box?.y ?? 0).toBeLessThan(844)
    }
  } finally {
    await stopProxiedForge(page, forge)
  }
})
