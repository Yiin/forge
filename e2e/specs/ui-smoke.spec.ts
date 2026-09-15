import { expect, test } from '@playwright/test'
import {
  launchForge,
  proxyForgeApi,
  stopProxiedForge,
} from '../helpers/forgeServer.js'

test('creates a project, sends a prompt, and replays the full streamed reply', async ({
  page,
  baseURL,
}) => {
  const forge = await launchForge({
    // The reply has to overflow the phone viewport so the timeline scrolls.
    env: { FORGE_E2E_REPLY_REPEAT: '120' },
    fakeAgentEnv: { FORGE_MOCK_PROMPT_DELAY_MS: '120' },
  })
  try {
    if (test.info().project.name.startsWith('phone'))
      await page.setViewportSize({ width: 390, height: 844 })
    await proxyForgeApi(page, forge)
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
    // The shadcn rebuild collapsed the desktop/phone shell classes into one
    // `.phone-shell` hook on the app root; both viewports use it now.
    const shell = '.phone-shell'
    await page
      .locator(shell)
      .getByRole('button', { name: 'Add project' })
      .click()
    const projectDialog = page.getByRole('dialog', { name: 'Create project' })
    await projectDialog.getByLabel('Name').fill('Browser project')
    await projectDialog.getByLabel('Folder path').fill(forge.dataDir)
    await projectDialog.getByRole('button', { name: 'Create project' }).click()
    await page.waitForURL(/\/draft\//, { timeout: 10_000 })
    await expect(page.getByLabel('Workspace')).toBeVisible()
    await expect(page.getByLabel('Branch')).toHaveText('main')
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
    if (test.info().project.name === 'desktop') {
      await page.setViewportSize({ width: 1320, height: 880 })
      const form = page.locator('.composer-root')
      const pill = page.locator('.chat-composer-glass')
      await expect(form).toHaveAttribute('data-composer-mode', 'compact')
      expect((await pill.boundingBox())?.height).toBe(49)
      expect(
        await pill.evaluate((node) => getComputedStyle(node).borderRadius),
      ).toBe('26px')
      await composer.fill(
        'A line that wraps as the conversation narrows. '.repeat(6),
      )
      await expect(form).toHaveAttribute('data-composer-mode', 'expanded')
      const wideHeight = (await composer.boundingBox())!.height
      await composer.evaluate((node: HTMLTextAreaElement) =>
        node.setSelectionRange(5, 20),
      )
      await page.setViewportSize({ width: 1000, height: 880 })
      await expect
        .poll(async () => (await composer.boundingBox())!.height)
        .toBeGreaterThan(wideHeight)
      expect(
        await composer.evaluate((node: HTMLTextAreaElement) => [
          node.selectionStart,
          node.selectionEnd,
        ]),
      ).toEqual([5, 20])
      await composer.fill('line\n'.repeat(80))
      await expect
        .poll(async () => (await pill.boundingBox())!.height)
        .toBe(308)
      await composer.fill('')
      await page.setViewportSize({ width: 1320, height: 880 })
      await expect(form).toHaveAttribute('data-composer-mode', 'compact')
    }
    if (test.info().project.name.startsWith('phone')) {
      await expect(composer).toBeVisible()
      await expect(composer).toBeEnabled()
      const box = await composer.boundingBox()
      expect(box?.y).toBeGreaterThan(0)
      expect(box?.y ?? 0).toBeLessThan(844)
      // The composer floats over the timeline, so the reserved inset has to
      // keep the last row clear of it, even once the reply scrolls.
      const lastRow = page.locator(`${shell} .chat-row`).last()
      await expect(lastRow).toBeVisible()
      await expect
        .poll(() =>
          page
            .locator(`${shell} .chat-timeline`)
            .evaluate((node) => node.scrollTop),
        )
        .toBeGreaterThan(0)
      const composerBox = page.locator(`${shell} .composer-root`)
      const shortHeight = (await composerBox.boundingBox())?.height ?? 0
      // A taller composer grows the reserved inset, so the timeline has to
      // scroll further to keep the last row clear.
      await composer.fill('line\n'.repeat(8))
      await expect
        .poll(async () => (await composerBox.boundingBox())?.height ?? 0)
        .toBeGreaterThan(shortHeight)
      const rowBox = await lastRow.boundingBox()
      const formBox = await composerBox.boundingBox()
      expect((rowBox?.y ?? 0) + (rowBox?.height ?? 0)).toBeLessThanOrEqual(
        formBox?.y ?? 0,
      )
    }
  } finally {
    await stopProxiedForge(page, forge)
  }
})
