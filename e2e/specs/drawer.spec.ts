import { expect, test } from '@playwright/test'
import {
  launchForge,
  proxyForgeApi,
  stopProxiedForge,
} from '../helpers/forgeServer.js'

test('phone drawer opens on-screen within the viewport', async ({
  page,
  baseURL,
}) => {
  test.skip(
    !test.info().project.name.startsWith('phone'),
    'drawer only exists in the phone shell',
  )
  const forge = await launchForge()
  try {
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
    await page.locator('.phone-shell').getByLabel('Open navigation').click()
    const drawer = page.locator('.drawer')
    await expect(drawer).toBeVisible()
    // The drawer slides in; poll until the transform settles.
    await expect
      .poll(async () => (await drawer.boundingBox())?.x)
      .toBeGreaterThanOrEqual(0)
    const box = await drawer.boundingBox()
    expect(box?.width ?? 391).toBeLessThanOrEqual(390)
    await expect(drawer.getByText('forge')).toBeVisible()
  } finally {
    await stopProxiedForge(page, forge)
  }
})
