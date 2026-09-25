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
      ).toBe('22px')
      await composer.fill(
        'A line that wraps as the conversation narrows. '.repeat(6),
      )
      await expect(form).toHaveAttribute('data-composer-mode', 'expanded')
      const wideBox = (await composer.boundingBox())!
      const wideHeight = wideBox.height
      await composer.evaluate((node: HTMLTextAreaElement) =>
        node.setSelectionRange(5, 20),
      )
      await page.setViewportSize({ width: 850, height: 880 })
      await expect
        .poll(async () => (await composer.boundingBox())!.width)
        .toBeLessThan(wideBox.width)
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
        .toBe(304)
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
      // How far the last row reaches past the composer's top edge.
      const overlap = () =>
        page.evaluate((shell) => {
          const rows = document.querySelectorAll(`${shell} .chat-row`)
          const row = rows[rows.length - 1].getBoundingClientRect()
          const form = document
            .querySelector(`${shell} .composer-root`)!
            .getBoundingClientRect()
          return row.bottom - form.top
        }, shell)
      // Record the overlap in every frame the composer grows. This observer
      // runs after the app's own, so it sees each frame as it paints.
      await page.evaluate((shell) => {
        const overlay = document.querySelector(
          `${shell} [data-composer-overlay]`,
        )!
        const probe = window as unknown as { worstOverlap: number }
        probe.worstOverlap = -Infinity
        new ResizeObserver(() => {
          const rows = document.querySelectorAll(`${shell} .chat-row`)
          const row = rows[rows.length - 1].getBoundingClientRect()
          const form = document
            .querySelector(`${shell} .composer-root`)!
            .getBoundingClientRect()
          probe.worstOverlap = Math.max(
            probe.worstOverlap,
            row.bottom - form.top,
          )
        }).observe(overlay)
      }, shell)
      // A taller composer grows the reserved inset, so the timeline has to
      // scroll further to keep the last row clear. The composer eases its
      // height, so wait for it to settle; a read between frames can see
      // the composer ahead of the frame the browser painted.
      await composer.fill('line\n'.repeat(8))
      await expect
        .poll(async () => (await composerBox.boundingBox())?.height ?? 0)
        .toBeGreaterThan(shortHeight)
      await expect.poll(overlap).toBeLessThanOrEqual(0)
      // The transcript moves in the same frame as the composer, so no
      // painted frame puts the row under it while it grows.
      expect(
        await page.evaluate(
          () => (window as unknown as { worstOverlap: number }).worstOverlap,
        ),
      ).toBeLessThanOrEqual(0)
    }
  } finally {
    await stopProxiedForge(page, forge)
  }
})
